drop database crm(force);

create database crm
select *
FROM tenants


select *
FROM organizations


select users.password_hash,*
from iam.users
--This is a bcrypt hash of Admin@123, cost factor 12



select *
from public.users
where users.manager_id is null
where email = 'komal.hegde@fitclass.in'

select *
from crm.marketing_leads


select *
from public.user_org_mapping

select *
from public.branches

select *
from public.ad_campaigns

select *
from public.marketing_platforms


select *
from public.campaign_statuses

select *
from public.test

ALTER ROLE lead_svc WITH PASSWORD 'lead_svc_pwd';
ALTER ROLE tenant_dash_svc WITH PASSWORD 'tenant_dash_svc_pwd';

ALTER ROLE crm_service WITH PASSWORD 'crm_service_pwd';


select *
from ext.api_clients

select *
from ext.api_client_orgs

select *
from ext.meta_tenant_config

select *
from ext.meta_tenan