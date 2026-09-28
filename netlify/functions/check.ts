import type { Config } from "@netlify/functions";
import checkTennis from "./check-tennis.js";

export default async (req: Request) => {
  const url = new URL(req.url);

  if (url.searchParams.get("send") !== "1") {
    url.searchParams.set("dryRun", "1");
  }

  return checkTennis(new Request(url, req));
};

export const config: Config = {
  path: "/check",
};
