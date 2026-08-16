#!/usr/bin/env bun
import { allocatePort, resolveRange } from "./port-allocator.ts";

const [argService, , argBranch] = process.argv.slice(2);

const service = process.env.PASEO_SCRIPTNAME ?? argService ?? "web";
const branch = process.env.PASEO_BRANCH_NAME ?? argBranch ?? "";

const port = allocatePort({ service, branch, range: resolveRange() });
process.stdout.write(String(port));
