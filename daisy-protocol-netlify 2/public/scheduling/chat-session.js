export const DEFAULT_TIMEOUT = 30 * 60000;
export const greeting = {role:'assistant',content:'Hi! How can I help you today?'};
export const freshSession = (now=Date.now()) => ({sessionId:crypto.randomUUID(),messages:[{...greeting}],lastActivityAt:now,pending:null});
export const isExpired = (session,timeout=DEFAULT_TIMEOUT,now=Date.now()) => !Number.isFinite(session?.lastActivityAt) || now-session.lastActivityAt>=timeout;
export function restoreSession(saved,timeout=DEFAULT_TIMEOUT,now=Date.now()) {
 if(!saved || isExpired(saved,timeout,now) || !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(saved.sessionId) || !Array.isArray(saved.messages))return freshSession(now);
 return {...saved,messages:saved.messages.filter(m=>['user','assistant'].includes(m.role)&&typeof m.content==='string').slice(-60)};
}
