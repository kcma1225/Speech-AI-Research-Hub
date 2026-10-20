import { clearSession } from "@/lib/auth";
export async function POST(){await clearSession();return new Response(null,{status:303,headers:{Location:"/login","Cache-Control":"no-store"}})}
