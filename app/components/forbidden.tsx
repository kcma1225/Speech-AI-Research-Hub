import Link from "next/link";
export function Forbidden(){return <main className="forbidden-page"><span className="status">403 / 權限不足</span><h1>需要 Owner 權限</h1><p>目前帳號無法管理成員與邀請。若需要調整權限，請聯絡 Owner。</p><Link className="button primary" href="/">返回首頁</Link></main>}
