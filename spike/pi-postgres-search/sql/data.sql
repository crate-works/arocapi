-- Usage: psql -v n=200000 -f data.sql
\set ON_ERROR_STOP on

select setseed(0.42) \gset

create or replace function geohash(lat float8, lon float8, len int) returns text
language plpgsql immutable as $$
declare
  alphabet constant text := '0123456789bcdefghjkmnpqrstuvwxyz';
  lat_lo float8 := -90; lat_hi float8 := 90;
  lon_lo float8 := -180; lon_hi float8 := 180;
  result text := '';
  bit int := 0; ch int := 0; even boolean := true; mid float8;
begin
  while length(result) < len loop
    if even then
      mid := (lon_lo + lon_hi) / 2;
      if lon >= mid then ch := ch * 2 + 1; lon_lo := mid; else ch := ch * 2; lon_hi := mid; end if;
    else
      mid := (lat_lo + lat_hi) / 2;
      if lat >= mid then ch := ch * 2 + 1; lat_lo := mid; else ch := ch * 2; lat_hi := mid; end if;
    end if;
    even := not even;
    bit := bit + 1;
    if bit = 5 then
      result := result || substr(alphabet, ch + 1, 1);
      bit := 0; ch := 0;
    end if;
  end loop;
  return result;
end $$;

-- Rank k drawn with P(k) ∝ ~1/k, like word frequencies in real text.
create or replace function zipf(size int) returns int
language sql volatile as $$ select floor(exp(random() * ln(size)))::int $$;

drop table if exists vocab;
create unlogged table vocab (rank int primary key, word text not null);
insert into vocab
select i, string_agg(chr(97 + ((i * 7919 + k * 104729) % 26)), '' order by k)
from generate_series(1, 20000) i, generate_series(1, 4 + i % 6) k
group by i;
-- Guarantee uniqueness: suffix the rank in letters.
update vocab set word = word || translate(rank::text, '0123456789', 'abcdefghij');
drop table if exists vocab_words;
create unlogged table vocab_words as select array_agg(word order by rank) as w from vocab;

drop table if exists gen;
create unlogged table gen as
select
  g.i,
  case when g.i % 50 = 0 then 'Collection' when g.i % 50 < 10 then 'Object' else 'File' end as entity_type,
  random() < 0.05 as draft,
  case when random() < 0.9 then date '1950-01-01' + (random() * 27000)::int end as date_from,
  case when g.i % 50 < 10 and random() < 0.7 then 110 + random() * 70 end as lon,
  -45 + random() * 55 as lat
from generate_series(1, :n) g(i);

drop table if exists gen_text;
create unlogged table gen_text as
select
  g.i,
  (select string_agg(v.w[zipf(20000)], ' ') from generate_series(1, 3 + g.i % 3), vocab_words v) as name,
  (select string_agg(v.w[zipf(20000)], ' ')
     from generate_series(1, case when g.entity_type = 'File' then 3 + g.i % 4 else 60 + g.i % 61 end), vocab_words v) as description
from gen g;

insert into entity (id, name, description, entity_type, member_of, root_collection, metadata_license_id, content_license_id, meta)
select
  'https://catalog.example.org/' || lower(g.entity_type) || '/' || g.i,
  t.name, t.description, g.entity_type,
  case when g.entity_type <> 'Collection' then 'https://catalog.example.org/collection/' || (g.i / 50 * 50) end,
  case when g.entity_type <> 'Collection' then 'https://catalog.example.org/collection/' || (g.i / 50 * 50) end,
  'licence-' || (g.i % 4), 'licence-' || (g.i % 4),
  case when g.draft then '{"draft": true}'::jsonb else '{}'::jsonb end
from gen g join gen_text t using (i);

insert into search_entity (entity_id, name, body, tsv, date_from, location, geohash)
select
  e.id, e.name, e.name || ' ' || e.description,
  setweight(to_tsvector('simple', e.name), 'A') || setweight(to_tsvector('simple', e.description), 'B'),
  g.date_from,
  case when g.lon is not null then point(g.lon, g.lat) end,
  case when g.lon is not null then geohash(g.lat, g.lon, 12) end
from gen g join entity e on e.id = 'https://catalog.example.org/' || lower(g.entity_type) || '/' || g.i
order by g.i;

insert into search_facet (sid, field, value)
select s.sid, f.field, f.value
from search_entity s
join entity e on e.id = s.entity_id
cross join lateral (
  select 'entityType', e.entity_type
  union all select 'licence', e.content_license_id
  union all select 'country', 'country-' || zipf(40)
  union all select distinct 'language', 'language-' || zipf(300) from generate_series(1, 1 + (s.sid % 2)::int)
  union all select 'mediaType', 'media-' || zipf(15) where e.entity_type = 'File'
) f(field, value)
on conflict do nothing;

drop table gen, gen_text, vocab_words;
vacuum analyze entity;
vacuum analyze search_entity;
vacuum analyze search_facet;
