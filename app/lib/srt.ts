export type Cue={start:number;end:number;text:string};
const time=(value:string)=>{const m=/^(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(value.trim());if(!m)return NaN;return Number(m[1])*3600+Number(m[2])*60+Number(m[3])+Number(m[4].padEnd(3,"0"))/1000};
export function parseSrt(source:string):Cue[]{
  const cues:Cue[]=[];
  for(const block of source.replace(/^\uFEFF/,"").replace(/\r\n?/g,"\n").split(/\n{2,}/)){
    const lines=block.split("\n").filter(Boolean);
    const at=lines.findIndex(line=>line.includes("-->"));
    if(at<0)continue;
    const [a,b]=lines[at].split("-->");
    const start=time(a),end=time((b??"").trim().split(/\s+/)[0]??"");
    const text=lines.slice(at+1).join("\n").replace(/<[^>]+>/g,"").replace(/\{\\[^}]*\}/g,"").trim();
    if(Number.isFinite(start)&&Number.isFinite(end)&&end>=start&&text)cues.push({start,end,text:text.slice(0,2000)});
  }
  return cues.sort((x,y)=>x.start-y.start);
}
