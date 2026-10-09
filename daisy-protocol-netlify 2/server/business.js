// All reusable business knowledge lives here; environment values override defaults.
export function businessContext(env = process.env) {
 return {
  name: env.BUSINESS_NAME || 'Daisy Protocol',
  description: env.BUSINESS_DESCRIPTION || 'Utah AI implementation company helping small and midsize businesses reduce repetitive work and deploy private AI.',
  services: env.BUSINESS_SERVICES || 'Workflow automation; private/local AI; internal document search; customer communication drafts; lead and CRM workflows; document processing and reporting.',
  hours: env.BUSINESS_HOURS || 'Not provided. Do not invent opening hours or calendar availability.',
  address: env.BUSINESS_ADDRESS || 'Serving Utah businesses. No street address provided.',
  phone: env.BUSINESS_PHONE || 'Not provided.',
  faq: env.BUSINESS_FAQ || 'Initial AI workflow consultation is free and lasts 20 minutes. No technical preparation required. Implementations begin with a scoped pilot; pricing depends on scope. Existing tools can be connected. Private AI hosting, permissions, and data flows are assessed before implementation. Human review remains part of important decisions.',
  timeZone: env.BUSINESS_TIME_ZONE || 'America/Denver'
 };
}
export function sessionTimeoutMs(value = process.env.CHAT_SESSION_TIMEOUT_MINUTES) {
 const minutes = Number(value || 30);
 return (Number.isFinite(minutes) && minutes >= 1 && minutes <= 1440 ? minutes : 30) * 60000;
}
