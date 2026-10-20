import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { LoginForm } from "@/components/login-form";
import { Breadcrumbs } from "@/components/breadcrumbs";
export default async function LoginPage(){if(await currentUser())redirect("/");return <main className="auth-page"><section className="auth-context"><div className="auth-brand"><img className="auth-logo" src="/brand-mark.svg" width="96" height="96" alt=""/><h1>Speech-AI<br/>Research Hub</h1></div><p>會議、實驗、逐字稿與論文工作集中於同一份研究紀錄。</p><span className="status">PRIVATE / LAB WORKSPACE</span></section><section className="auth-form-wrap"><div className="auth-panel"><Breadcrumbs/><LoginForm/></div></section></main>}
