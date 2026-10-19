-- Usage: psql -v runs=5 -f bench.sql
\set ON_ERROR_STOP on

create or replace function q_from(term text, filters text) returns text
language sql immutable as $$
  select format(
    'search_entity s join entity e on e.id = s.entity_id%s where not coalesce((e.meta->>''draft'')::boolean, false)%s%s',
    case when term is null then '' else format(', plainto_tsquery(''simple'', %L) q', term) end,
    case when term is null then '' else ' and s.tsv @@ q' end,
    coalesce(filters, ''))
$$;

create or replace function q_page(term text, filters text, sort text, page_offset int) returns text
language sql immutable as $$
  select format(
    'with page as (select s.sid, s.entity_id, s.body, %s as score, count(*) over () as total from %s order by %s limit 20 offset %s) '
    'select entity_id, score, total, %s from page',
    case when term is null then '0' else 'ts_rank_cd(s.tsv, q)' end,
    q_from(term, filters),
    case when sort = 'name' then 's.name, s.sid' when term is null then 's.sid' else 'score desc, s.sid' end,
    page_offset,
    case when term is null then 'null' else format('ts_headline(''simple'', body, plainto_tsquery(''simple'', %L))', term) end)
$$;

create or replace function q_facets(term text, filters text) returns text
language sql immutable as $$
  select format(
    'with m as (select s.sid from %s) '
    'select field, value, n from (select f.field, f.value, count(*) as n, '
    'row_number() over (partition by f.field order by count(*) desc, f.value) as rn '
    'from search_facet f join m using (sid) '
    'where f.field in (''entityType'', ''licence'', ''country'', ''language'', ''mediaType'') '
    'group by f.field, f.value) x where rn <= 20',
    q_from(term, filters))
$$;

create or replace function q_geo(term text) returns text
language sql immutable as $$
  select format(
    'select left(s.geohash, 3) as cell, count(*) from %s group by 1',
    q_from(term, ' and s.location <@ box(point(140, -20), point(160, 0))'))
$$;

drop table if exists results;
create table results (
  seq serial,
  label text,
  matches bigint,
  median_ms numeric,
  max_ms numeric
);

create or replace function bench(label text, term text, filters text, query text, runs int) returns void
language plpgsql as $$
declare
  t0 timestamptz;
  times numeric[] := '{}';
  matches bigint;
begin
  execute 'select count(*) from ' || q_from(term, filters) into matches;
  execute query;
  for i in 1..runs loop
    t0 := clock_timestamp();
    execute query;
    times := times || extract(epoch from clock_timestamp() - t0)::numeric * 1000;
  end loop;
  insert into results (label, matches, median_ms, max_ms)
  select label, matches,
    round((select percentile_cont(0.5) within group (order by t) from unnest(times) t)::numeric, 1),
    round((select max(t) from unnest(times) t), 1);
end $$;

select word as common from vocab where rank = 1 \gset
select word as mid from vocab where rank = 30 \gset
select word as rare from vocab where rank = 3000 \gset

\set lang ' and exists (select 1 from search_facet f where f.sid = s.sid and f.field = ''language'' and f.value = ''language-1'') and exists (select 1 from search_facet f where f.sid = s.sid and f.field = ''entityType'' and f.value = ''Object'')'
\set dates ' and s.date_from between ''1970-01-01'' and ''1989-12-31'''

select bench('common term: page 1', :'common', null, q_page(:'common', null, 'relevance', 0), :runs) \g /dev/null
select bench('common term: facets', :'common', null, q_facets(:'common', null), :runs) \g /dev/null
select bench('common term: page at offset 5000', :'common', null, q_page(:'common', null, 'relevance', 5000), :runs) \g /dev/null
select bench('common term: page 1 sorted by name', :'common', null, q_page(:'common', null, 'name', 0), :runs) \g /dev/null
select bench('common term + 2 filters: page 1', :'common', :'lang', q_page(:'common', :'lang', 'relevance', 0), :runs) \g /dev/null
select bench('common term + 2 filters: facets', :'common', :'lang', q_facets(:'common', :'lang'), :runs) \g /dev/null
select bench('common term + date range: page 1', :'common', :'dates', q_page(:'common', :'dates', 'relevance', 0), :runs) \g /dev/null
select bench('common term: geohash grid in bbox', :'common', ' and s.location <@ box(point(140, -20), point(160, 0))', q_geo(:'common'), :runs) \g /dev/null
select bench('mid term: page 1', :'mid', null, q_page(:'mid', null, 'relevance', 0), :runs) \g /dev/null
select bench('mid term: facets', :'mid', null, q_facets(:'mid', null), :runs) \g /dev/null
select bench('rare term: page 1', :'rare', null, q_page(:'rare', null, 'relevance', 0), :runs) \g /dev/null
select bench('rare term: facets', :'rare', null, q_facets(:'rare', null), :runs) \g /dev/null
select bench('two terms (AND): page 1', :'mid' || ' ' || :'common', null, q_page(:'mid' || ' ' || :'common', null, 'relevance', 0), :runs) \g /dev/null
select bench('empty query: page 1', null, null, q_page(null, null, 'relevance', 0), :runs) \g /dev/null
select bench('empty query: facets', null, null, q_facets(null, null), :runs) \g /dev/null
select bench('empty query: page at offset 5000', null, null, q_page(null, null, 'relevance', 5000), :runs) \g /dev/null
select bench('empty query: page 1 sorted by name', null, null, q_page(null, null, 'name', 0), :runs) \g /dev/null
select bench('empty query + 2 filters: page 1', null, :'lang', q_page(null, :'lang', 'relevance', 0), :runs) \g /dev/null
select bench('empty query + 2 filters: facets', null, :'lang', q_facets(null, :'lang'), :runs) \g /dev/null
select bench('empty query: geohash grid in bbox', null, ' and s.location <@ box(point(140, -20), point(160, 0))', q_geo(null), :runs) \g /dev/null

\pset tuples_only on
\pset format unaligned
select '| Query | Matches | Median ms | Max ms |' union all select '| --- | ---: | ---: | ---: |' union all
select format('| %s | %s | %s | %s |', label, matches, median_ms, max_ms) from (select * from results order by seq) r;
