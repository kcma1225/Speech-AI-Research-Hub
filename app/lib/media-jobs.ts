import { notify } from "./notify";
import { spawn } from "node:child_process";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { db } from "./db";
import { ensureSchema } from "./schema";

type Job = {id:string;item_id:string;user_id:string;status:string;stage:string;progress:number;duration_seconds:number|null;error:string|null;created_at:string};
// Route bundles share one Node process but not module state.
const stateKey=Symbol.for("speech-hub.media-jobs.state");
type MediaState={active:Map<string,ReturnType<typeof spawn>>;recovery?:Promise<void>};
const globals=globalThis as typeof globalThis & {[stateKey]:MediaState};
const state=globals[stateKey]??(globals[stateKey]={active:new Map()});
const active=state.active;
const dir = () => process.env.UPLOAD_DIR ?? "/data/uploads";
const location = (id:string,suffix:string) => path.join(dir(),`${id}.${suffix}`);
async function recoverInterruptedJobs(){
  state.recovery??=(async()=>{
    await ensureSchema();
    const pool=await db();
    const stopped=await pool.query<{id:string}>("UPDATE media_jobs SET status='failed',stage='中斷',error='服務重新啟動；請重新上傳',finished_at=now() WHERE status='processing' RETURNING id");
    for(const job of stopped.rows){
      await unlink(location(job.id,"source")).catch(()=>{});
      await unlink(location(job.id,"m4a")).catch(()=>{});
    }
  })().catch(error=>{state.recovery=undefined;throw error});
  await state.recovery;
}

export async function listJobs(userId:string){await recoverInterruptedJobs();return (await (await db()).query<Job>("SELECT id,item_id,user_id,status,stage,progress,duration_seconds,error,created_at FROM media_jobs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20",[userId])).rows}
export async function getJob(id:string,userId:string){await recoverInterruptedJobs();return (await (await db()).query<Job>("SELECT id,item_id,user_id,status,stage,progress,duration_seconds,error,created_at FROM media_jobs WHERE id=$1 AND user_id=$2",[id,userId])).rows[0]}
export async function createJob(itemId:string,userId:string,file:File){
  await recoverInterruptedJobs();const pool=await db();
  const item=await pool.query("SELECT id FROM items WHERE id=$1",[itemId]);if(!item.rowCount)throw new Error("筆記不存在。");
  const id=randomUUID();await mkdir(dir(),{recursive:true});
  await pool.query("INSERT INTO media_jobs(id,item_id,user_id,status,stage,progress,file_name) VALUES($1,$2,$3,'processing','準備媒體',0,$4)",[id,itemId,userId,file.name]);
  try {await writeFile(location(id,"source"),Buffer.from(await file.arrayBuffer()),{flag:"wx"});}
  catch(error){await pool.query("UPDATE media_jobs SET status='failed',stage='失敗',error='上傳寫入失敗' WHERE id=$1",[id]);await unlink(location(id,"source")).catch(()=>{});throw error}
  void runJob(id,itemId,userId,file.name).catch(()=>{});
  return id;
}
async function runJob(id:string,itemId:string,userId:string,fileName:string){
  const pool=await db();const source=location(id,"source"),output=location(id,"m4a");
  let cancelled=false;
  try {
    await pool.query("UPDATE media_jobs SET stage='分析媒體' WHERE id=$1 AND status='processing'",[id]);
    const duration=await new Promise<number|null>(resolve=>{
      const probe=spawn("ffprobe",["-v","error","-show_entries","format=duration","-of","default=noprint_wrappers=1:nokey=1",source]);let value="";
      const timer=setTimeout(()=>probe.kill("SIGKILL"),15_000);
      probe.stdout.on("data",chunk=>value+=chunk);probe.on("error",()=>{clearTimeout(timer);resolve(null)});probe.on("close",()=>{clearTimeout(timer);const seconds=Number(value.trim());resolve(Number.isFinite(seconds)&&seconds>0?seconds:null)});
    });
    await pool.query("UPDATE media_jobs SET duration_seconds=$2,stage='音訊轉碼' WHERE id=$1 AND status='processing'",[id,duration]);
    const current=await pool.query("SELECT status FROM media_jobs WHERE id=$1",[id]);
    if(current.rows[0]?.status!=="processing")return;
    const execution=new Promise<{code:number|null;cancelled:boolean}>((resolve,reject)=>{
      const child=spawn("ffmpeg",["-hide_banner","-loglevel","error","-nostdin","-y","-i",source,"-vn","-map_metadata","-1","-ac","1","-ar","24000","-c:a","aac","-b:a","48k","-progress","pipe:1",output],{stdio:["ignore","pipe","pipe"]});active.set(id,child);
      let stdout="",last=0;
      child.stdout.on("data",chunk=>{stdout+=String(chunk);const lines=stdout.split(/\r?\n/);stdout=lines.pop()??"";for(const line of lines){if(line.startsWith("out_time_us=")&&duration){const seconds=Number(line.slice(12))/1e6;const progress=Math.min(95,Math.floor(seconds/duration*95));if(progress>=last+2){last=progress;void pool.query("UPDATE media_jobs SET progress=GREATEST(progress,$2) WHERE id=$1 AND status='processing'",[id,progress]).catch(()=>{})}}}});
      child.stderr.resume();
      child.on("error",reject);child.on("close",code=>{active.delete(id);resolve({code,cancelled:cancelled||code===null})});
    });
    const latest=await pool.query("SELECT status FROM media_jobs WHERE id=$1",[id]);
    if(latest.rows[0]?.status!=="processing")active.get(id)?.kill("SIGTERM");
    const result=await execution;
    if(result.code!==0)throw new Error(result.cancelled?"已取消":"無法解析媒體檔");
    await pool.query("UPDATE media_jobs SET stage='儲存結果',progress=98 WHERE id=$1 AND status='processing'",[id]);
    const client=await pool.connect();let old:string|null=null;
    try {await client.query("BEGIN");const job=await client.query("SELECT status FROM media_jobs WHERE id=$1 FOR UPDATE",[id]);if(job.rows[0]?.status!=="processing"){cancelled=true;await client.query("ROLLBACK");return}
      const previous=await client.query("SELECT storage_name FROM items WHERE id=$1 FOR UPDATE",[itemId]);if(!previous.rowCount)throw new Error("筆記已刪除");old=previous.rows[0].storage_name;
      await client.query("UPDATE items SET file_name=$1,storage_name=$2,mime_type='audio/mp4',updated_by=$3,updated_at=now() WHERE id=$4",[fileName,`${id}.m4a`,userId,itemId]);
      await client.query("UPDATE media_jobs SET status='completed',stage='完成',progress=100,finished_at=now() WHERE id=$1",[id]);await client.query("COMMIT");
    }catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}
    if(old && old!==`${id}.m4a`)await unlink(path.join(dir(),old)).catch(()=>{});
    void notify([userId],{kind:"media",title:"影音處理完成",body:fileName,url:`/items/${itemId}`},`media-${id}`).catch(()=>undefined);
  }catch(error){
    await pool.query("UPDATE media_jobs SET status='failed',stage='失敗',error=$2,finished_at=now() WHERE id=$1 AND status='processing'",[id,error instanceof Error?error.message:"處理失敗"]).catch(()=>{});
  }finally{await unlink(source).catch(()=>{});const job=await pool.query("SELECT status FROM media_jobs WHERE id=$1",[id]).catch(()=>null);if(job?.rows[0]?.status!=="completed")await unlink(output).catch(()=>{});active.delete(id)}
}
export async function cancelJob(id:string,userId:string){
  const pool=await db();const result=await pool.query("UPDATE media_jobs SET status='cancelled',stage='已取消',finished_at=now() WHERE id=$1 AND user_id=$2 AND status='processing' RETURNING id",[id,userId]);
  if(!result.rowCount)return false;
  const child=active.get(id);
  if(child)child.kill("SIGTERM");
  // runJob removes files when FFmpeg exits; without an active process, remove leftovers now.
  if(!child){await unlink(location(id,"source")).catch(()=>{});await unlink(location(id,"m4a")).catch(()=>{})}
  return true;
}
