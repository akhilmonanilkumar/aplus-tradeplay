-- Tick store. Runs once when the database volume is first created.
create extension if not exists timescaledb;

create table if not exists trades (
  ts     timestamptz      not null,
  venue  text             not null,
  symbol text             not null,
  price  double precision not null,
  size   double precision not null,  -- underlying units (contracts × contract value)
  side   smallint         not null   -- +1 aggressive buy, -1 aggressive sell
);
select create_hypertable('trades', 'ts', chunk_time_interval => interval '1 day', if_not_exists => true);
create index if not exists trades_sym_ts on trades (venue, symbol, ts desc);
alter table trades set (timescaledb.compress, timescaledb.compress_segmentby = 'venue,symbol');
select add_compression_policy('trades', interval '2 days', if_not_exists => true);
select add_retention_policy('trades', interval '180 days', if_not_exists => true);

-- One-second bars with buy and sell volume, for tick-level backtests and footprint history.
create materialized view if not exists bars_1s with (timescaledb.continuous) as
select time_bucket('1 second', ts) as t, venue, symbol,
       first(price, ts) as o, max(price) as h, min(price) as l, last(price, ts) as c,
       sum(size) filter (where side > 0) as buy, sum(size) filter (where side < 0) as sell, count(*) as n
from trades group by 1, 2, 3 with no data;
select add_continuous_aggregate_policy('bars_1s', start_offset => interval '1 hour', end_offset => interval '5 seconds', schedule_interval => interval '30 seconds', if_not_exists => true);
