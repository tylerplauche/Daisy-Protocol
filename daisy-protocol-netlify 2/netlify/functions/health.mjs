export default async function health(){return Response.json({ok:true},{headers:{'Cache-Control':'no-store'}})}
export const config={path:'/api/health'};
