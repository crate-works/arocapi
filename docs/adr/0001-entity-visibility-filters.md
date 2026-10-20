# 1. Entity visibility is a query filter, separate from access

Date: 2026-10-12

## Status

Accepted

## Context

Consumers need to hide some entities from some users entirely: drafts and
private crates seen only by admins, or only entities a user is entitled to,
whether decided by their groups or by an external arbiter such as REMS. How
visibility is decided is up to the consumer. Access is decided per entity after
it has been fetched, so it can't remove one, and removing rows after the
query would break totals, `limit`/`offset` pagination and search facet counts,
which come from the database and the search backend.

## Decision

- **Visibility** (does this entity exist for this request?) and **access**
  (what can this request do with a visible entity?) are separate layers.
  Visibility runs first; the access and entity transformer pipeline runs
  unchanged on visible entities.
- Visibility is applied inside the queries. Consumers supply two required
  filters: `entityVisibilityFilter`, which returns a Prisma `where` over
  `Entity`'s columns and `meta`, and `searchVisibilityFilter`, which returns
  a filter over the search document's declared fields in one language shared
  by every search backend (ADR 0003). The two are deliberately separate, with
  no rule language spanning both: consumers own both the database and the
  search documents, and keeping the filters in agreement is their
  responsibility.
- The search backend enforces search visibility. arocapi passes it the
  search visibility filter, which it must apply to the hits, the total and
  the facets, so facets only count visible entities. Loading hits from the
  database applies the entity filter too, so a mismatch gives a short page
  rather than a leak.
- Neither filter has a default. Public repositories opt in explicitly with
  `AllVisibleEntityFilter` and `AllVisibleSearchFilter`.
- Direct requests for a hidden entity get a 404, the same as a missing entity.
  With `promptLoginForHidden`, an anonymous request (per the consumer's
  `isAuthenticated`) for a hidden entity gets a 401 so the client can prompt a
  login. A hidden entity never gets a 403: that would reveal an entity the
  request can't see. Missing entities always get 404.
- Visibility never cascades from collections; consumers who want that filter
  on `rootCollection`.

## Consequences

- Introducing the filters was a breaking change.
- Visibility rules must be expressible as database and search queries. Rules
  that can only be checked per entity after fetching belong in the access
  layer instead.
- Consumers must declare any field their visibility rules use and include
  it in their search documents.
- A custom search backend that ignores visibility leaks hidden entities into
  totals and facets; the library can't check it.
