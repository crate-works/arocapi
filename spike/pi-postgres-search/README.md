# Spike: Postgres search latency on a Raspberry Pi

Throwaway harness for [Spike: Postgres search latency on a Raspberry Pi](https://github.com/crate-works/arocapi/issues/79). Needs only Docker: `postgres:18` runs on arm64 and everything else is SQL.

- `sql/schema.sql`: arocapi's `entity` table plus the proposed search tables (weighted `tsvector` + GIN, integer surrogate key, facet rows, date, `point` + GiST, stored geohash).
- `sql/data.sql`: synthetic catalogue of `n` entities. 2% collections, 18% objects, 80% files; Zipf-distributed 20k-word vocabulary; five facet fields (~5 rows per entity); 5% drafts hidden by visibility.
- `sql/bench.sql`: the queries a Postgres backend would issue, each the median of `RUNS` warm runs. Every query joins `entity` for visibility; pages compute an exact `total` and `ts_rank_cd`, with `ts_headline` on the page only.
- `run.sh`: loads and benchmarks each size, writing `results-<host>-<time>.md`.

Timings are server-side only: no Node, Prisma or HTTP overhead.

## Running on a Pi

1. Use a Pi 4 or 5 (4 GB is the recommended raspbocrate spec) on the storage raspbocrate boots from (SD card or USB SSD). Stop the raspbocrate stack so nothing else competes.
2. Copy this directory to the Pi, for example `scp -r spike/pi-postgres-search pi@raspbocrate.local:`.
3. On the Pi: `cd pi-postgres-search && ./run.sh 10000 50000 200000`. The container is capped at 1 GB RAM and 4 CPUs (`SPIKE_MEM` and `SPIKE_CPUS` override this).
4. Copy the `results-*.md` file back, then `docker compose down`.

Generating the catalogue dominates the run: 200k entities took 14 minutes on one desktop core, so expect an hour or more on a Pi. Run `./run.sh 10000 50000` first if time is short. The generator's speed says nothing about the backend's `index`.

`results-desktop-baseline.md` is the same run on a Ryzen 9 7950X with the container capped at 1 CPU, for comparison.
