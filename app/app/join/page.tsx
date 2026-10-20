import { JoinDialog } from "@/components/join-dialog";
import { Breadcrumbs } from "@/components/breadcrumbs";
export default async function JoinPage({searchParams}:{searchParams:Promise<{token?:string}>}){const {token=""}=await searchParams;return <main className="auth-page" aria-hidden={false}><section className="auth-context"><h1>Join<br/>Research<br/>Hub</h1><p>使用邀請連結建立帳號。連結可能有期限或使用次數限制。</p></section><section className="auth-form-wrap"><div className="auth-panel"><Breadcrumbs/><p className="muted">驗證邀請中</p></div></section><JoinDialog token={token}/></main>}
