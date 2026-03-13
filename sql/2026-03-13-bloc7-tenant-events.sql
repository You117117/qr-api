create table if not exists public.tenant_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid null,
  table_id uuid null,
  table_code text null,
  session_id uuid null,
  ticket_id uuid null,
  event_type text not null,
  event_code text not null,
  severity text not null default 'info' check (severity in ('info','warn','error')),
  message text null,
  source text not null default 'api' check (source in ('api','staff','client','system')),
  request_id text null,
  payload_json jsonb null,
  created_at timestamptz not null default now()
);

create index if not exists idx_tenant_events_created_at on public.tenant_events (created_at desc);
create index if not exists idx_tenant_events_tenant_created on public.tenant_events (tenant_id, created_at desc);
create index if not exists idx_tenant_events_table_created on public.tenant_events (table_code, created_at desc);
create index if not exists idx_tenant_events_session_created on public.tenant_events (session_id, created_at desc);
create index if not exists idx_tenant_events_event_code on public.tenant_events (event_code, created_at desc);
create index if not exists idx_tenant_events_severity on public.tenant_events (severity, created_at desc);
