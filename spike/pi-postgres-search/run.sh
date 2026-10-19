#!/usr/bin/env bash
# Usage: ./run.sh [entities ...]   e.g. ./run.sh 10000 50000 200000
set -euo pipefail
cd "$(dirname "$0")"

sizes=("$@")
[ ${#sizes[@]} -eq 0 ] && sizes=(10000 50000 200000)
runs=${RUNS:-5}
out=results-$(hostname)-$(date +%Y%m%d-%H%M).md
psql() { docker compose exec -T -e PGOPTIONS='-c client_min_messages=warning' postgres psql -U postgres -X -q "$@"; }

docker compose up -d --wait

{
  echo "# Postgres search spike: $(hostname)"
  echo
  echo '```'
  tr -d '\0' </proc/device-tree/model 2>/dev/null && echo || true
  uname -srm
  free -m | head -2
  df -h . | tail -1
  docker compose exec -T postgres postgres --version
  psql -t -c "select name || ' = ' || current_setting(name) from pg_settings where name in ('shared_buffers', 'effective_cache_size', 'work_mem', 'maintenance_work_mem', 'max_parallel_workers_per_gather', 'jit', 'random_page_cost')"
  echo "container: mem ${SPIKE_MEM:-1g}, cpus ${SPIKE_CPUS:-4}; runs per query: $runs"
  echo '```'
} | tee "$out"

for n in "${sizes[@]}"; do
  echo "== $n entities: loading" >&2
  start=$(date +%s)
  psql -f /sql/schema.sql
  psql -v n="$n" -f /sql/data.sql
  load=$(($(date +%s) - start))
  {
    echo
    echo "## $n entities"
    echo
    echo "Load (generate + index + analyze): ${load}s"
    echo
    psql -t -A -c "select '- ' || relname || ': ' || pg_size_pretty(pg_total_relation_size(oid)) from pg_class where relname in ('entity', 'search_entity', 'search_facet') order by 1"
    psql -t -A -c "select '- search_facet rows: ' || count(*) from search_facet"
    echo
    echo "== $n entities: benchmarking" >&2
    psql -v runs="$runs" -f /sql/bench.sql
  } | tee -a "$out"
done

echo "Results written to $out" >&2
