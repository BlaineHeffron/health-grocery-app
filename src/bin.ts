#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { main } from "./cli.js";

process.exitCode = await main(process.argv.slice(2));
