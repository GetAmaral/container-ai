import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

serve(async (req) => {
  return new Response(JSON.stringify({
    status: "deprecated",
    message: "Use google-calendar-sync-cron instead"
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
});
