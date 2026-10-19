# Postgres search spike: desktop baseline (Ryzen 9 7950X, container capped at 1 CPU)

```
Linux 7.3.0-9-generic x86_64
               total        used        free      shared  buff/cache   available
Mem:           30712       14234        3526        1551       15040       16478
/dev/nvme0n1p2  1.8T  1.2T  571G  68% /
postgres (PostgreSQL) 18.6 (Debian 18.6-1.pgdg13+2)
 effective_cache_size = 768MB
 jit = off
 maintenance_work_mem = 128MB
 max_parallel_workers_per_gather = 2
 random_page_cost = 4
 shared_buffers = 256MB
 work_mem = 16MB

container: mem 1g, cpus 1; runs per query: 5
```

## 10000 entities

Load (generate + index + analyze): 42s

- entity: 5472 kB
- search_entity: 16 MB
- search_facet: 9032 kB
- search_facet rows: 52865

| Query | Matches | Median ms | Max ms |
| --- | ---: | ---: | ---: |
| common term: page 1 | 5338 | 11.1 | 11.6 |
| common term: facets | 5338 | 14.0 | 15.0 |
| common term: page at offset 5000 | 5338 | 12.2 | 12.4 |
| common term: page 1 sorted by name | 5338 | 12.2 | 13.4 |
| common term + 2 filters: page 1 | 318 | 4.0 | 4.1 |
| common term + 2 filters: facets | 318 | 4.1 | 4.2 |
| common term + date range: page 1 | 1373 | 4.0 | 4.1 |
| common term: geohash grid in bbox | 108 | 0.8 | 0.8 |
| mid term: page 1 | 713 | 2.8 | 3.1 |
| mid term: facets | 713 | 5.6 | 5.7 |
| rare term: page 1 | 12 | 0.5 | 0.5 |
| rare term: facets | 12 | 0.4 | 0.4 |
| two terms (AND): page 1 | 581 | 2.9 | 3.0 |
| empty query: page 1 | 9479 | 3.8 | 4.0 |
| empty query: facets | 9479 | 16.5 | 16.5 |
| empty query: page at offset 5000 | 9479 | 3.9 | 3.9 |
| empty query: page 1 sorted by name | 9479 | 4.1 | 4.3 |
| empty query + 2 filters: page 1 | 318 | 2.6 | 2.7 |
| empty query + 2 filters: facets | 318 | 3.9 | 27.8 |
| empty query: geohash grid in bbox | 108 | 0.7 | 0.7 |

## 50000 entities

Load (generate + index + analyze): 210s

- entity: 27 MB
- search_entity: 58 MB
- search_facet: 45 MB
- search_facet rows: 264259

| Query | Matches | Median ms | Max ms |
| --- | ---: | ---: | ---: |
| common term: page 1 | 27056 | 72.9 | 92.8 |
| common term: facets | 27056 | 102.1 | 107.2 |
| common term: page at offset 5000 | 27056 | 75.4 | 77.2 |
| common term: page 1 sorted by name | 27056 | 73.3 | 75.1 |
| common term + 2 filters: page 1 | 1545 | 17.5 | 18.8 |
| common term + 2 filters: facets | 1545 | 19.6 | 19.7 |
| common term + date range: page 1 | 6605 | 21.8 | 22.2 |
| common term: geohash grid in bbox | 668 | 4.4 | 4.5 |
| mid term: page 1 | 3614 | 14.0 | 14.7 |
| mid term: facets | 3614 | 70.7 | 78.2 |
| rare term: page 1 | 42 | 1.0 | 1.1 |
| rare term: facets | 42 | 0.8 | 0.8 |
| two terms (AND): page 1 | 3002 | 15.0 | 15.6 |
| empty query: page 1 | 47618 | 24.4 | 25.6 |
| empty query: facets | 47618 | 107.0 | 111.9 |
| empty query: page at offset 5000 | 47618 | 23.6 | 24.1 |
| empty query: page 1 sorted by name | 47618 | 26.3 | 27.3 |
| empty query + 2 filters: page 1 | 1548 | 14.1 | 14.4 |
| empty query + 2 filters: facets | 1548 | 17.0 | 17.6 |
| empty query: geohash grid in bbox | 668 | 3.9 | 4.1 |

## 200000 entities

Load (generate + index + analyze): 845s

- entity: 107 MB
- search_entity: 220 MB
- search_facet: 188 MB
- search_facet rows: 1056965

| Query | Matches | Median ms | Max ms |
| --- | ---: | ---: | ---: |
| common term: page 1 | 107557 | 309.5 | 349.9 |
| common term: facets | 107557 | 406.0 | 485.7 |
| common term: page at offset 5000 | 107557 | 304.4 | 434.1 |
| common term: page 1 sorted by name | 107557 | 311.3 | 341.3 |
| common term + 2 filters: page 1 | 6174 | 78.3 | 78.7 |
| common term + 2 filters: facets | 6174 | 89.0 | 90.1 |
| common term + date range: page 1 | 26364 | 204.0 | 289.9 |
| common term: geohash grid in bbox | 2717 | 19.9 | 21.3 |
| mid term: page 1 | 14383 | 115.2 | 179.6 |
| mid term: facets | 14383 | 208.5 | 276.5 |
| rare term: page 1 | 158 | 1.9 | 2.0 |
| rare term: facets | 158 | 2.4 | 2.4 |
| two terms (AND): page 1 | 11891 | 184.3 | 195.8 |
| empty query: page 1 | 190196 | 144.1 | 162.2 |
| empty query: facets | 190196 | 412.0 | 465.0 |
| empty query: page at offset 5000 | 190196 | 126.5 | 163.0 |
| empty query: page 1 sorted by name | 190196 | 157.3 | 161.3 |
| empty query + 2 filters: page 1 | 6185 | 64.9 | 86.2 |
| empty query + 2 filters: facets | 6185 | 76.9 | 78.9 |
| empty query: geohash grid in bbox | 2727 | 18.5 | 18.9 |
