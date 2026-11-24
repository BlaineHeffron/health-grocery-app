# Migrations

Plain SQL files applied by `hga db migrate` in lexicographic filename order, each in its own
transaction, and recorded by filename in `schema_migrations`. Applied files are never edited;
add a new file instead.

Name: `NNNN_<feature>_<what>.sql` (lowercase, digits, underscores), for example
`0002_rotation_state.sql` or `0002_prices_cache.sql`. Parallel branches may pick the same number:
the filename is the id, so distinct names never collide and the order stays deterministic.
