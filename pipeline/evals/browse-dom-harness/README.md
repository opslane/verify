# Browse DOM Harness

This directory scaffolds a real-DOM browse eval suite for the pipeline.
It will use the real `browse` binary against local static pages served from this directory.
It complements the fake browse suite by exercising real DOM interactions without depending on the network or external apps.

Run the full DOM suite with `npm run eval:browse:dom` from `pipeline/`.
For a bounded manual smoke run, use `BROWSE_DOM_LIVE_SMOKE=1 npm run eval:browse:dom -- --case tooltip-hover-success`.
