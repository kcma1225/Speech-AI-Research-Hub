import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { UserMenu } from "./user-menu";
import { Breadcrumbs } from "./breadcrumbs";
import { MediaJobCenter } from "./media-job-center";
import { HeaderNotifications } from "./header-notifications";
export async function Shell({children,layout="default"}:{children:React.ReactNode;layout?:"default"|"document"}){const user=await requireUser();return <div className={layout==="document"?"shell shell-document":"shell"}><aside className="rail"><Link href="/" className="rail-mark" aria-label="Speech-AI Research Hub 首頁"><img src="/brand-mark.svg" width="48" height="48" alt=""/><span>Speech-AI<br/>Research Hub</span></Link></aside><main className="main"><header className="topbar"><Link href="/" className="topbar-mark" aria-label="Speech-AI Research Hub 首頁"><img src="/brand-mark.svg" width="36" height="36" alt=""/><span>Speech-AI<br/>Research Hub</span></Link><Breadcrumbs/><div className="topbar-actions"><HeaderNotifications/><UserMenu user={user}/></div></header>{children}<MediaJobCenter/></main></div>}
