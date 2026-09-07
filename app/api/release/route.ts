import { APP_BUILD_ID, APP_VERSION, releaseLocation } from "@/lib/app-release";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const location = releaseLocation(new URL(request.url).origin);
  return Response.json({ schema: 1, version: APP_VERSION, buildId: APP_BUILD_ID, environment: location.environment }, {
    headers: {
      "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
      "CDN-Cache-Control": "no-store",
      "Vercel-CDN-Cache-Control": "no-store",
    },
  });
}
