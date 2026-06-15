// Deprecated — replaced by assign-ride
Deno.serve(async (_req) => {
  return new Response('deprecated', { status: 200 })
})
