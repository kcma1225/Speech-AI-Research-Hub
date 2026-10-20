import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { Shell } from "@/components/shell";

export default async function OverleafPage(){
  await requireUser();
  const url=process.env.OVERLEAF_URL ?? "http://overleaf.localhost/";
  return <Shell>
    <section className="page-head compact-head"><h1>Overleaf</h1></section>
    <p>在獨立分頁開啟 Overleaf。瀏覽器會限制跨網站 iframe 的登入 Cookie；在 HTTPS 與同站網域設定完成前，直接開啟可避免 Session error。</p>
    <p><a className="button primary" href={url} target="_blank" rel="noopener noreferrer">開啟 Overleaf（新分頁）</a></p>
    <p className="muted">Overleaf 使用獨立帳號。完成後可返回此分頁，或使用 <Link href="/">首頁</Link>。</p>
  </Shell>;
}
