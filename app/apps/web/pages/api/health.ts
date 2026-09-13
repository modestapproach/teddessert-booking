import type { NextApiRequest, NextApiResponse } from "next";

// CF Containers health check endpoint — must respond before the full app
// is ready so the Container DO knows the process is alive.
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  res.status(200).json({ status: "ok" });
}
