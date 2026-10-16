#!/usr/bin/env bun
import { main } from "./main.ts";

process.exit(await main(process.argv.slice(2)));
