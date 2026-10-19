# Postgres search spike: Raspberry Pi 5 (4 GB, SD card)

200k not run: 10k and 50k answered the question.

```
Raspberry Pi 5 Model B Rev 1.0
Linux 6.18.50+rpt-rpi-2712 aarch64
               total        used        free      shared  buff/cache   available
Mem:            4045         652        1758          34        1874        3392
/dev/mmcblk0p2   58G  4.8G   51G   9% /
postgres (PostgreSQL) 18.6 (Debian 18.6-1.pgdg13+2)
 effective_cache_size = 768MB
 jit = off
 maintenance_work_mem = 128MB
 max_parallel_workers_per_gather = 2
 random_page_cost = 4
 shared_buffers = 256MB
 work_mem = 16MB

container: mem 1g, cpus 4; runs per query: 5
```

## 10000 entities

Load (generate + index + analyze): 126s

- entity: 5472 kB
- search_entity: 16 MB
- search_facet: 9032 kB
- search_facet rows: 52865

| Query | Matches | Median ms | Max ms |
| --- | ---: | ---: | ---: |
| common term: page 1 | 5338 | 31.4 | 31.7 |
| common term: facets | 5338 | 41.2 | 41.7 |
| common term: page at offset 5000 | 5338 | 31.0 | 31.1 |
| common term: page 1 sorted by name | 5338 | 34.5 | 35.0 |
| common term + 2 filters: page 1 | 318 | 11.7 | 11.8 |
| common term + 2 filters: facets | 318 | 12.3 | 12.6 |
| common term + date range: page 1 | 1373 | 13.7 | 13.7 |
| common term: geohash grid in bbox | 108 | 2.3 | 2.4 |
| mid term: page 1 | 713 | 9.6 | 9.7 |
| mid term: facets | 713 | 19.1 | 19.4 |
| rare term: page 1 | 12 | 1.5 | 1.6 |
| rare term: facets | 12 | 0.9 | 0.9 |
| two terms (AND): page 1 | 581 | 11.0 | 11.1 |
| empty query: page 1 | 9479 | 13.5 | 13.6 |
| empty query: facets | 9479 | 48.0 | 48.2 |
| empty query: page at offset 5000 | 9479 | 14.4 | 14.7 |
| empty query: page 1 sorted by name | 9479 | 14.9 | 15.0 |
| empty query + 2 filters: page 1 | 318 | 6.6 | 6.8 |
| empty query + 2 filters: facets | 318 | 11.2 | 11.2 |
| empty query: geohash grid in bbox | 108 | 2.0 | 2.0 |

## 50000 entities

Load (generate + index + analyze): 633s

- entity: 27 MB
- search_entity: 58 MB
- search_facet: 45 MB
- search_facet rows: 264259

| Query | Matches | Median ms | Max ms |
| --- | ---: | ---: | ---: |
| common term: page 1 | 27056 | 160.7 | 167.6 |
| common term: facets | 27056 | 117.8 | 118.8 |
| common term: page at offset 5000 | 27056 | 171.4 | 172.2 |
| common term: page 1 sorted by name | 27056 | 167.8 | 182.8 |
| common term + 2 filters: page 1 | 1545 | 48.9 | 49.2 |
| common term + 2 filters: facets | 1545 | 57.7 | 57.9 |
| common term + date range: page 1 | 6605 | 59.6 | 59.8 |
| common term: geohash grid in bbox | 668 | 15.1 | 15.2 |
| mid term: page 1 | 3614 | 41.0 | 44.7 |
| mid term: facets | 3614 | 53.2 | 53.4 |
| rare term: page 1 | 42 | 2.9 | 3.0 |
| rare term: facets | 42 | 2.0 | 2.1 |
| two terms (AND): page 1 | 3002 | 58.2 | 59.1 |
| empty query: page 1 | 47618 | 68.9 | 69.4 |
| empty query: facets | 47618 | 115.1 | 119.4 |
| empty query: page at offset 5000 | 47618 | 71.3 | 71.7 |
| empty query: page 1 sorted by name | 47618 | 77.2 | 77.8 |
| empty query + 2 filters: page 1 | 1548 | 33.6 | 33.6 |
| empty query + 2 filters: facets | 1548 | 52.4 | 52.5 |
| empty query: geohash grid in bbox | 668 | 12.9 | 13.1 |
