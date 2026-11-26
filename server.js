// Runs the site as a normal Node server (your computer, Render, any VPS).
import "./lib/env.js";
import http from "node:http";
import { handler } from "./lib/app.js";

const PORT = Number(process.env.PORT) || 3000;
http.createServer(handler).listen(PORT, () => console.log(`Bolti Parchi running on http://localhost:${PORT}`));
