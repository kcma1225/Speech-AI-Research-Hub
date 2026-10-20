import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import yauzl from "yauzl";

export const SLIDES_DIR=process.env.SLIDES_DIR??"/data/slides";
const allowed=new Set([".qmd",".md",".yml",".yaml",".css",".scss",".json",".bib",".csl",".png",".jpg",".jpeg",".webp",".gif",".svg",".csv",".tsv",".pdf",".woff",".woff2"]);
const ignored=new Set([".git","node_modules",".env","secrets"]);
export type Scan={qmd:string[];css:string[];files:number;bytes:number};

function safeName(name:string){if(name.includes("\\")||name.includes("\0")||name.split("/").some(part=>part===".."||part==="."))throw new Error("ZIP 包含不安全路徑。");const normalized=path.posix.normalize(name);if(normalized.startsWith("/")||normalized===".."||normalized.startsWith("../"))throw new Error("ZIP 包含不安全路徑。");return normalized}
export async function extractZip(zipPath:string,target:string){await rm(target,{recursive:true,force:true});await mkdir(target,{recursive:true});return new Promise<Scan>((resolve,reject)=>yauzl.open(zipPath,{lazyEntries:true,decodeStrings:true,validateEntrySizes:true},(error,zip)=>{if(error||!zip)return reject(error);let files=0,bytes=0;const qmd:string[]=[],css:string[]=[];zip.readEntry();zip.on("entry",entry=>{try{const name=safeName(entry.fileName);const parts=name.split("/");if(parts.some(part=>ignored.has(part)||part.startsWith(".env")))throw new Error("ZIP 包含禁止目錄。");if(/\/$/.test(name)){zip.readEntry();return}files++;bytes+=entry.uncompressedSize;if(files>2000||bytes>500*1024*1024||entry.uncompressedSize>100*1024*1024)throw new Error("ZIP 超過檔案數量或容量限制。");if(parts.length>12)throw new Error("ZIP 路徑層級過深。");const extension=path.extname(name).toLowerCase();if(!allowed.has(extension))throw new Error(`不支援檔案類型：${extension||name}`);const mode=(entry.externalFileAttributes>>>16)&0xffff;if((mode&0o170000)===0o120000)throw new Error("ZIP 不可包含 symbolic link。");if(extension===".qmd")qmd.push(name);if(extension===".css"||extension===".scss")css.push(name);const output=path.join(target,...parts);mkdir(path.dirname(output),{recursive:true}).then(()=>zip.openReadStream(entry,(streamError,stream)=>{if(streamError||!stream)return reject(streamError);const chunks:Buffer[]=[];stream.on("data",chunk=>chunks.push(Buffer.from(chunk)));stream.on("error",reject);stream.on("end",()=>writeFile(output,Buffer.concat(chunks)).then(()=>zip.readEntry(),reject))}))}catch(cause){zip.close();reject(cause)}});zip.on("end",()=>resolve({qmd,css,files,bytes}));zip.on("error",reject)}))}
export function projectDir(id:string){return path.join(SLIDES_DIR,"projects",id)}
export const shareKey=()=>randomBytes(24).toString("base64url");
export function chooseEntry(qmd:string[],selection:string){
  if(!qmd.length)throw new Error("ZIP 未包含 QMD 檔案。");
  if(selection){if(!qmd.includes(selection))throw new Error("找不到指定入口 QMD。");return selection}
  if(qmd.includes("index.qmd"))return "index.qmd";
  if(qmd.length===1)return qmd[0];
  throw new Error("ZIP 包含多個 QMD，請選擇入口檔："+qmd.join("、"));
}
export async function prepareSource(source:string,entry:string){
  const extension=path.join(source,path.posix.dirname(entry),"_extensions","annotate");
  await mkdir(extension,{recursive:true});
  for(const name of ["_extension.yml","annotate.css","annotate.js"]){
    await cp(path.join(process.cwd(),"slide-assets","annotate",name),path.join(extension,name));
  }
  const file=path.join(source,...entry.split("/"));
  // Uploaded ZIP is one deck, not a Quarto website. Ignore project-level config.
  await rm(path.join(source,"_quarto.yml"),{force:true});
  await rm(path.join(source,"_quarto.yaml"),{force:true});
  const text=await readFile(file,"utf8");
  const end=text.startsWith("---\n")?text.indexOf("\n---",4):-1;
  if(text.startsWith("---\n")&&end<0)throw new Error("QMD front matter 未關閉。");
  const front=end>=0?text.slice(4,end):"";
  const plugin=/^revealjs-plugins:\s*$/m.test(front);
  const annotated=/^[ \t]*-[ \t]*annotate\s*$/m.test(front);
  if(!annotated){
    if(plugin)await writeFile(file,text.slice(0,end)+"\n  - annotate"+text.slice(end));
    else if(end>=0)await writeFile(file,text.slice(0,end)+"\nrevealjs-plugins:\n  - annotate"+text.slice(end));
    else await writeFile(file,"---\nrevealjs-plugins:\n  - annotate\n---\n"+text);
  }
  return path.posix.basename(entry,".qmd")+".html";
}
export async function enqueueRender(id:string,versionId:string,entry:string){
  const job=path.join(SLIDES_DIR,"jobs",versionId);
  await rm(job,{recursive:true,force:true});
  await mkdir(job,{recursive:true});
  await cp(path.join(projectDir(id),"versions",versionId,"source"),path.join(job,"source"),{recursive:true});
  await writeFile(path.join(job,"entry"),entry);
  await writeFile(path.join(job,"queued"),"");
}
export async function saveVersionSource(id:string,versionId:string,file:File,entryChoice:string){
  const root=path.join(projectDir(id),"versions",versionId),source=path.join(root,"source");
  await mkdir(root,{recursive:true});
  const zip=path.join(root,"source.zip");
  await writeFile(zip,Buffer.from(await file.arrayBuffer()));
  try{
    const scan=await extractZip(zip,source);
    const entry=chooseEntry(scan.qmd,entryChoice);
    const html=await prepareSource(source,entry);
    await rm(zip);
    return {entry,html,scan};
  }catch(error){await rm(root,{recursive:true,force:true});throw error}
}
export const newVersionId=()=>randomUUID();
