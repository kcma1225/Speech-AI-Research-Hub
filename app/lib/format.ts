const pad=(value:number)=>String(value).padStart(2,"0");
const taipei=(value:string|number|Date)=>new Date(new Date(value).getTime()+8*60*60*1000);
export function formatDate(value:string|number|Date){const d=taipei(value);return `${d.getUTCFullYear()}/${pad(d.getUTCMonth()+1)}/${pad(d.getUTCDate())}`}
export function formatDateTime(value:string|number|Date){const d=taipei(value);return `${formatDate(value)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`}
