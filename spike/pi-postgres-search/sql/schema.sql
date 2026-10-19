-- arocapi's entity table, plus the search tables proposed in "Who owns the search index?" (#74).
drop table if exists search_facet, search_entity, entity cascade;

create table entity (
  id varchar(768) primary key,
  name varchar(512) not null,
  description text not null,
  entity_type varchar(255) not null,
  member_of varchar(768),
  root_collection varchar(768),
  metadata_license_id varchar(255) not null,
  content_license_id varchar(255) not null,
  meta jsonb
);

create table search_entity (
  sid bigint generated always as identity primary key,
  entity_id varchar(768) not null unique references entity (id) on delete cascade,
  name text not null,
  body text not null,
  tsv tsvector not null,
  date_from date,
  location point,
  geohash varchar(12)
);
create index search_entity_tsv on search_entity using gin (tsv);
create index search_entity_name on search_entity (name, sid);
create index search_entity_date on search_entity (date_from);
create index search_entity_location on search_entity using gist (location);
create index search_entity_geohash on search_entity (geohash);

create table search_facet (
  sid bigint not null references search_entity (sid) on delete cascade,
  field varchar(64) not null,
  value varchar(255) not null,
  primary key (field, value, sid)
);
create index search_facet_sid on search_facet (sid, field);
