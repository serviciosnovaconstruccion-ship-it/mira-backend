import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "8mb" }));

const CFG = {
  port: process.env.PORT || 8787,
  anthropicKey: process.env.ANTHROPIC_API_KEY,
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseKey: process.env.SUPABASE_SERVICE_KEY,
  allowedOrigin: process.env.ALLOWED_ORIGIN || "*",
  dailyBudgetCLP: Number(process.env.DAILY_BUDGET_CLP || 5000),
  maxPerDevicePerDay: Number(process.env.MAX_PER_DEVICE_DAY || 5),
  maxGlobalPerDay: Number(process.env.MAX_GLOBAL_DAY || 400),
  modelTriage: "claude-haiku-4-5-20251001",
  modelFull: "claude-opus-4-8",
  costTriageCLP: 8,
  costFullCLP: 110,
  brcThreshold: 0.85,
};

for (const k of ["anthropicKey","supabaseUrl","supabaseKey"]) {
  if (!CFG[k]) { console.error(`FALTA ${k}`); process.exit(1); }
}

const supabase = createClient(CFG.supabaseUrl, CFG.supabaseKey);
app.use(cors({ origin: CFG.allowedOrigin === "*" ? true : CFG.allowedOrigin.split(",") }));
app.use("/api/", rateLimit({ windowMs: 60000, max: 20 }));

const CATALOG = {
  gasfiteria: { nombre:"Agua y gasfitería", ico:"🚰", items:{
    cambio_griferia:{d:"Cambio de grifería",min:20000,med:25000,max:50000,mat:18000},
    fuga_agua:{d:"Reparación de fuga de agua",min:60000,med:120000,max:180000,mat:15000},
    wc:{d:"Reparación de WC",min:25000,med:30000,max:60000,mat:20000},
    destape:{d:"Destape de cañería",min:30000,med:55000,max:100000,mat:8000},
    flexible:{d:"Cambio de flexible o sifón",min:20000,med:35000,max:60000,mat:12000},
  }},
  electricidad: { nombre:"Electricidad", ico:"💡", items:{
    punto_electrico:{d:"Reparar punto eléctrico",min:5000,med:15000,max:28000,mat:6000},
    luminaria:{d:"Cambio de luminaria",min:15000,med:18000,max:35000,mat:0},
    cortocircuito:{d:"Arreglo de cortocircuito",min:20000,med:25000,max:50000,mat:5000},
    automaticos:{d:"Reemplazo de automáticos",min:70000,med:120000,max:250000,mat:45000},
  }},
  revestimiento: { nombre:"Muros y revestimientos", ico:"🧱", items:{
    humedad:{d:"Tratamiento de humedad en muro",min:50000,med:105000,max:200000,mat:30000},
    pintura:{d:"Reparación de pintura",min:70000,med:100000,max:150000,mat:35000},
    ceramica:{d:"Reposición de cerámica",min:70000,med:120000,max:200000,mat:40000},
    melamina:{d:"Reparación de melamina",min:25000,med:55000,max:100000,mat:25000},
  }},
  cerrajeria: { nombre:"Chapas y puertas", ico:"🔑", items:{
    chapa:{d:"Cambio de chapa o cerradura",min:15000,med:30000,max:45000,mat:18000},
    manilla:{d:"Reparación de manilla o bisagra",min:12000,med:22000,max:40000,mat:10000},
  }},
};
const IVA = 0.19;

function buildPrompt(catKey) {
  const cat = CATALOG[catKey];
  const itemList = Object.entries(cat.items).map(([k,v])=>`${k}: ${v.d}`).join("\n");
  return `Eres el motor de diagnóstico visual de MIRA para reparaciones del hogar en Chile. Analiza la imagen en la categoría "${cat.nombre}".
Opciones (usa la clave exacta): ${itemList}
Responde SOLO con JSON válido sin markdown:
{"en_alcance":bool,"confianza":0.0-1.0,"item_key":"clave","titulo":"máx 5 palabras","severidad":"Leve|Moderada|Grave","descripcion":"1-2 frases","solucion":"1-2 frases","cantidad":entero}
Si la imagen no corresponde a la categoría o está borrosa: en_alcance:false.`;
}

function buildTriagePrompt(catKey) {
  return `¿Esta imagen muestra claramente un problema de "${CATALOG[catKey].nombre}" en un hogar? Responde solo JSON: {"usable":bool,"motivo":"breve"}`;
}

function today() { return new Date().toISOString().slice(0,10); }
function hashDevice(raw) { return crypto.createHash("sha256").update(String(raw)+"mira-salt").digest("hex").slice(0,32); }

async function getSpendToday() {
  try {
    const { data } = await supabase.from("daily_spend").select("*").eq("date",today()).single();
    return data || { date:today(), spent_clp:0, calls:0 };
  } catch { return { date:today(), spent_clp:0, calls:0 }; }
}

async function addSpend(clp) {
  const cur = await getSpendToday();
  const next = { date:today(), spent_clp:cur.spent_clp+clp, calls:cur.calls+1 };
  await supabase.from("daily_spend").upsert(next,{onConflict:"date"});
  return next;
}

async function callModel(model, maxTokens, content) {
  const r = await fetch("https://api.anthropic.com/v1/messages",{
    method:"POST",
    headers:{"Content-Type":"application/json","x-api-key":CFG.anthropicKey,"anthropic-version":"2023-06-01"},
    body:JSON.stringify({model,max_tokens:maxTokens,messages:[{role:"user",content}]}),
  });
  if(!r.ok) throw new Error("api_error_"+r.status);
  const data = await r.json();
  return (data.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("\n").replace(/```json|```/g,"").trim();
}

app.post("/api/diagnose", async (req,res) => {
  try {
    const {category,image,mime,deviceId,geo} = req.body;
    if(!category||!image||!CATALOG[category]) return res.status(400).json({error:"bad_request"});
    const deviceHash = hashDevice(deviceId||req.ip);
    const { count } = await supabase.from("diagnostics").select("*",{count:"exact",head:true}).eq("device_hash",deviceHash).gte("created_at",today()+"T00:00:00");
    if((count||0) >= CFG.maxPerDevicePerDay) return res.status(429).json({error:"device_limit",msg:"Alcanzaste el máximo de diagnósticos gratuitos por hoy."});
    const spend = await getSpendToday();
    if(spend.spent_clp >= CFG.dailyBudgetCLP) return res.status(503).json({error:"budget_paused",msg:"Servicio en pausa por hoy. Agenda una visita técnica."});
    const imgBlock = {type:"image",source:{type:"base64",media_type:mime||"image/jpeg",data:image}};
    let triage;
    try {
      const t = await callModel(CFG.modelTriage,150,[imgBlock,{type:"text",text:buildTriagePrompt(category)}]);
      triage = JSON.parse(t);
      await addSpend(CFG.costTriageCLP);
    } catch { triage={usable:true}; }
    if(triage.usable===false) return res.json({en_alcance:false,reason:"foto_no_usable",msg:"La foto no permite un diagnóstico claro. Intenta con mejor luz."});
    const raw = await callModel(CFG.modelFull,1000,[imgBlock,{type:"text",text:buildPrompt(category)}]);
    const newSpend = await addSpend(CFG.costFullCLP);
    let result;
    try { result=JSON.parse(raw); } catch { return res.json({en_alcance:false,reason:"parse_error"}); }
    const lowConf=(result.confianza||0)<CFG.brcThreshold;
    let budget=null;
    if(result.en_alcance){
      const item=CATALOG[category].items[result.item_key]||Object.values(CATALOG[category].items)[0];
      const qty=Math.max(1,Math.ceil(result.cantidad||1));
      const mat=(item.mat||0)*qty, mo=(item.med-(item.mat||0))*qty, neto=mat+mo, iva=Math.round(neto*IVA);
      budget={itemDesc:item.d,qty,mat,mo,neto,iva,total:neto+iva};
    }
    const caseId="MIRA-"+Date.now().toString(36).toUpperCase();
    await supabase.from("diagnostics").insert({case_id:caseId,category,device_hash:deviceHash,geo_lat:geo?.lat||null,geo_lng:geo?.lng||null,diagnosis:result,budget,confidence:result.confianza||null,low_confidence:lowConf,in_scope:!!result.en_alcance});
    res.json({caseId,...result,budget,lowConf});
  } catch(err) {
    console.error("diagnose_error:",err.message);
    res.status(500).json({error:"server_error",msg:"No pudimos completar el diagnóstico."});
  }
});

app.post("/api/feedback", async (req,res) => {
  try {
    const {caseId,realPriceCLP,diagnosisCorrect,notes,techKey}=req.body;
    if(!process.env.TECH_KEY||techKey!==process.env.TECH_KEY) return res.status(401).json({error:"unauthorized"});
    await supabase.from("diagnostics").update({real_price_clp:realPriceCLP,diagnosis_correct:diagnosisCorrect,tech_notes:notes,visited_at:new Date().toISOString()}).eq("case_id",caseId);
    res.json({ok:true});
  } catch { res.status(500).json({error:"server_error"}); }
});

app.get("/api/stats", async (req,res) => {
  if(!process.env.TECH_KEY||req.query.key!==process.env.TECH_KEY) return res.status(401).json({error:"unauthorized"});
  const {data:all}=await supabase.from("diagnostics").select("*");
  const spend=await getSpendToday();
  res.json({total:all?.length||0,spentTodayCLP:spend.spent_clp,callsToday:spend.calls,budgetCLP:CFG.dailyBudgetCLP});
});

app.get("/api/catalog",(req,res)=>{
  const pub={};
  for(const [k,v] of Object.entries(CATALOG)) pub[k]={nombre:v.nombre,ico:v.ico};
  res.json(pub);
});

app.get("/health",(req,res)=>res.json({ok:true,service:"mira-backend"}));
app.listen(CFG.port,()=>console.log(`MIRA backend en puerto ${CFG.port}`));
