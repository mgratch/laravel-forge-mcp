<!-- GENERATED FILE — run `npm run docs` to regenerate. -->

# Tool catalog

Every tool below maps to exactly one operation in the [Laravel Forge API](https://forge.laravel.com/docs/api-reference/introduction).

- **273** tools total
- **105** are asynchronous; **44** of those expose a status that can be polled and accept `wait: true`
- **28** are destructive and registered only when `FORGE_MCP_ALLOW_DESTRUCTIVE=1`
- **61** require a matching `confirm` argument

## Argument conventions

Path parameters, query parameters and request-body fields are flattened into a single
argument object. When a body field would collide with a path or query parameter, the body is
nested under a `body` object instead.

| Argument | Applies to | Meaning |
| --- | --- | --- |
| `organization` | every org-scoped tool | Organization **slug**. Omitted from the schema when `FORGE_ORGANIZATION` is set. |
| `page[size]`, `page[cursor]` | list tools | [Cursor pagination](https://forge.laravel.com/docs/api-reference/pagination). Default page size is 30; there is no total count. |
| `filter[…]` | list tools | [Exact-match filters](https://forge.laravel.com/docs/api-reference/filtering). No operators. |
| `sort` | list tools | Field name, `-` prefix to reverse, comma-separated for multiple. |
| `include` | a few list tools | [Relationship includes](https://forge.laravel.com/docs/api-reference/relationships). |
| `wait` | pollable async tools | Poll until the resource reaches a terminal state. Advertised only where the API exposes a readable status. |
| `confirm` | guarded tools | Must equal the tool name followed by its target fields, e.g. `"delete_servers server=12345"`. Each tool documents its own exact form. |

## Destructive tools

These are hidden unless `FORGE_MCP_ALLOW_DESTRUCTIVE=1`, and always require `confirm`.

| Tool | Endpoint |
| --- | --- |
| `delete_servers_database_backups` | `DELETE /orgs/{organization}/servers/{server}/database/backups/{backupConfiguration}` |
| `delete_servers_database_backups_instances` | `DELETE /orgs/{organization}/servers/{server}/database/backups/{backupConfiguration}/instances/{backup}` |
| `create_servers_database_backups_instances_restores` | `POST /orgs/{organization}/servers/{server}/database/backups/{backupConfiguration}/instances/{backup}/restores` |
| `delete_servers_database_schemas` | `DELETE /orgs/{organization}/servers/{server}/database/schemas/{database}` |
| `delete_servers_database_users` | `DELETE /orgs/{organization}/servers/{server}/database/users/{databaseUser}` |
| `delete_servers_sites_deploy_key` | `DELETE /orgs/{organization}/servers/{server}/sites/{site}/deploy-key` |
| `create_teams_recipes` | `POST /orgs/{organization}/teams/{team}/recipes` |
| `delete_teams_recipes` | `DELETE /orgs/{organization}/teams/{team}/recipes/{recipe}` |
| `create_roles` | `POST /orgs/{organization}/roles` |
| `update_roles` | `PUT /orgs/{organization}/roles/{role}` |
| `delete_roles` | `DELETE /orgs/{organization}/roles/{role}` |
| `delete_servers_ssh_keys` | `DELETE /orgs/{organization}/servers/{server}/ssh-keys/{key}` |
| `create_teams_server_credentials` | `POST /orgs/{organization}/teams/{team}/server-credentials` |
| `delete_teams_server_credentials` | `DELETE /orgs/{organization}/teams/{team}/server-credentials/{credential}` |
| `create_servers_archives` | `POST /orgs/{organization}/servers/archives` |
| `delete_servers` | `DELETE /orgs/{organization}/servers/{server}` |
| `delete_servers_php_versions` | `DELETE /orgs/{organization}/servers/{server}/php/versions/{phpVersion}` |
| `create_teams_servers` | `POST /orgs/{organization}/teams/{team}/servers` |
| `delete_teams_servers` | `DELETE /orgs/{organization}/teams/{team}/servers/{server}` |
| `delete_servers_sites` | `DELETE /orgs/{organization}/servers/{server}/sites/{site}` |
| `delete_storage_providers` | `DELETE /orgs/{organization}/storage-providers/{storageConfiguration}` |
| `create_teams` | `POST /orgs/{organization}/teams` |
| `update_teams` | `PUT /orgs/{organization}/teams/{team}` |
| `delete_teams` | `DELETE /orgs/{organization}/teams/{team}` |
| `update_teams_members` | `PUT /orgs/{organization}/teams/{team}/members/{user}` |
| `delete_teams_members` | `DELETE /orgs/{organization}/teams/{team}/members/{user}` |
| `create_teams_invites` | `POST /orgs/{organization}/teams/{team}/invites` |
| `delete_teams_invites` | `DELETE /orgs/{organization}/teams/{team}/invites/{invitation}` |

## Confirmation-gated tools

Not deletions, but able to interrupt a live service — stopping nginx has no `start`
counterpart in the API, so a mistake is not trivially reversible.

| Tool | Endpoint |
| --- | --- |
| `delete_servers_background_processes` | `DELETE /orgs/{organization}/servers/{server}/background-processes/{backgroundProcess}` |
| `delete_servers_sites_deployments_push_to_deploy` | `DELETE /orgs/{organization}/servers/{server}/sites/{site}/deployments/push-to-deploy` |
| `delete_servers_firewall_rules` | `DELETE /orgs/{organization}/servers/{server}/firewall-rules/{rule}` |
| `delete_servers_sites_integrations_horizon` | `DELETE /orgs/{organization}/servers/{server}/sites/{site}/integrations/horizon` |
| `delete_servers_sites_integrations_octane` | `DELETE /orgs/{organization}/servers/{server}/sites/{site}/integrations/octane` |
| `delete_servers_sites_integrations_reverb` | `DELETE /orgs/{organization}/servers/{server}/sites/{site}/integrations/reverb` |
| `delete_servers_sites_integrations_pulse` | `DELETE /orgs/{organization}/servers/{server}/sites/{site}/integrations/pulse` |
| `create_servers_sites_integrations_laravel_maintenance` | `POST /orgs/{organization}/servers/{server}/sites/{site}/integrations/laravel-maintenance` |
| `delete_servers_sites_integrations_laravel_scheduler` | `DELETE /orgs/{organization}/servers/{server}/sites/{site}/integrations/laravel-scheduler` |
| `delete_servers_nginx_templates` | `DELETE /orgs/{organization}/servers/{server}/nginx/templates/{nginxTemplate}` |
| `delete_servers_sites_redirect_rules` | `DELETE /orgs/{organization}/servers/{server}/sites/{site}/redirect-rules/{redirectRule}` |
| `delete_servers_scheduled_jobs` | `DELETE /orgs/{organization}/servers/{server}/scheduled-jobs/{job}` |
| `delete_servers_sites_scheduled_jobs` | `DELETE /orgs/{organization}/servers/{server}/sites/{site}/scheduled-jobs/{job}` |
| `delete_servers_sites_security_rules` | `DELETE /orgs/{organization}/servers/{server}/sites/{site}/security-rules/{securityRule}` |
| `delete_servers_archives` | `DELETE /orgs/{organization}/servers/archives/{server}` |
| `create_servers_background_processes_actions` | `POST /orgs/{organization}/servers/{server}/background-processes/{backgroundProcess}/actions` |
| `create_servers_actions` | `POST /orgs/{organization}/servers/{server}/actions` |
| `create_servers_services_nginx_actions` | `POST /orgs/{organization}/servers/{server}/services/nginx/actions` |
| `create_servers_services_postgres_actions` | `POST /orgs/{organization}/servers/{server}/services/postgres/actions` |
| `create_servers_services_redis_actions` | `POST /orgs/{organization}/servers/{server}/services/redis/actions` |
| `create_servers_services_mysql_actions` | `POST /orgs/{organization}/servers/{server}/services/mysql/actions` |
| `create_servers_services_php_actions` | `POST /orgs/{organization}/servers/{server}/services/php/actions` |
| `create_servers_services_supervisor_actions` | `POST /orgs/{organization}/servers/{server}/services/supervisor/actions` |
| `update_servers_php_versions_configs_fpm` | `PUT /orgs/{organization}/servers/{server}/php/versions/{phpVersion}/configs/fpm` |
| `update_servers_php_versions_configs_cli` | `PUT /orgs/{organization}/servers/{server}/php/versions/{phpVersion}/configs/cli` |
| `update_servers_php_versions_configs_pool` | `PUT /orgs/{organization}/servers/{server}/php/versions/{phpVersion}/configs/pool` |
| `delete_servers_php_opcache` | `DELETE /orgs/{organization}/servers/{server}/php/opcache` |
| `delete_servers_sites_domains` | `DELETE /orgs/{organization}/servers/{server}/sites/{site}/domains/{domainRecord}` |
| `create_servers_sites_domains_actions` | `POST /orgs/{organization}/servers/{server}/sites/{site}/domains/{domainRecord}/actions` |
| `update_servers_sites_domains_nginx` | `PUT /orgs/{organization}/servers/{server}/sites/{site}/domains/{domainRecord}/nginx` |
| `delete_servers_sites_domains_certificates` | `DELETE /orgs/{organization}/servers/{server}/sites/{site}/domains/{domainRecord}/certificates/{certificate}` |
| `create_servers_sites_domains_certificates_actions` | `POST /orgs/{organization}/servers/{server}/sites/{site}/domains/{domainRecord}/certificates/{certificate}/actions` |
| `update_servers_sites_nginx` | `PUT /orgs/{organization}/servers/{server}/sites/{site}/nginx` |

## All tools by resource

### Background Processes

Forge documentation: https://forge.laravel.com/docs/resources/background-processes

| Tool | Endpoint | Summary | Flags |
| --- | --- | --- | --- |
| `list_servers_background_processes` | `GET /orgs/{organization}/servers/{server}/background-processes` | List background processes | — |
| `create_servers_background_processes` | `POST /orgs/{organization}/servers/{server}/background-processes` | Create background process | async, pollable |
| `get_servers_background_processes` | `GET /orgs/{organization}/servers/{server}/background-processes/{backgroundProcess}` | Get background process | — |
| `update_servers_background_processes` | `PUT /orgs/{organization}/servers/{server}/background-processes/{backgroundProcess}` | Update background process | async, pollable |
| `delete_servers_background_processes` | `DELETE /orgs/{organization}/servers/{server}/background-processes/{backgroundProcess}` | Delete background process | **confirm**, async, pollable |
| `get_servers_background_processes_log` | `GET /orgs/{organization}/servers/{server}/background-processes/{backgroundProcess}/log` | Get background process log | — |

### Backups

Forge documentation: https://forge.laravel.com/docs/resources/database-backups

| Tool | Endpoint | Summary | Flags |
| --- | --- | --- | --- |
| `list_servers_database_backups` | `GET /orgs/{organization}/servers/{server}/database/backups` | List backup configurations | — |
| `create_servers_database_backups` | `POST /orgs/{organization}/servers/{server}/database/backups` | Create backup configuration | async, pollable |
| `get_servers_database_backups` | `GET /orgs/{organization}/servers/{server}/database/backups/{backupConfiguration}` | Get backup configuration | — |
| `update_servers_database_backups` | `PUT /orgs/{organization}/servers/{server}/database/backups/{backupConfiguration}` | Update backup configuration | async, pollable |
| `delete_servers_database_backups` | `DELETE /orgs/{organization}/servers/{server}/database/backups/{backupConfiguration}` | Delete backup configuration | **destructive**, async, pollable |
| `list_servers_database_backups_instances` | `GET /orgs/{organization}/servers/{server}/database/backups/{backupConfiguration}/instances` | List backups | — |
| `create_servers_database_backups_instances` | `POST /orgs/{organization}/servers/{server}/database/backups/{backupConfiguration}/instances` | Create backup | async, pollable |
| `get_servers_database_backups_instances` | `GET /orgs/{organization}/servers/{server}/database/backups/{backupConfiguration}/instances/{backup}` | Get backup | — |
| `delete_servers_database_backups_instances` | `DELETE /orgs/{organization}/servers/{server}/database/backups/{backupConfiguration}/instances/{backup}` | Delete backup | **destructive**, async, pollable |
| `create_servers_database_backups_instances_restores` | `POST /orgs/{organization}/servers/{server}/database/backups/{backupConfiguration}/instances/{backup}/restores` | Create a database restore from backup | **destructive**, async |

### Commands

Forge documentation: https://forge.laravel.com/docs/sites/commands

| Tool | Endpoint | Summary | Flags |
| --- | --- | --- | --- |
| `list_servers_sites_commands` | `GET /orgs/{organization}/servers/{server}/sites/{site}/commands` | List commands | — |
| `create_servers_sites_commands` | `POST /orgs/{organization}/servers/{server}/sites/{site}/commands` | Create command | async, pollable |
| `get_servers_sites_commands` | `GET /orgs/{organization}/servers/{server}/sites/{site}/commands/{command}` | Get command | — |
| `delete_servers_sites_commands` | `DELETE /orgs/{organization}/servers/{server}/sites/{site}/commands/{command}` | Delete command | — |
| `get_servers_sites_commands_output` | `GET /orgs/{organization}/servers/{server}/sites/{site}/commands/{command}/output` | Get command output | — |

### Databases

Forge documentation: https://forge.laravel.com/docs/resources/databases

| Tool | Endpoint | Summary | Flags |
| --- | --- | --- | --- |
| `list_servers_database_schemas` | `GET /orgs/{organization}/servers/{server}/database/schemas` | List database schemas | — |
| `create_servers_database_schemas` | `POST /orgs/{organization}/servers/{server}/database/schemas` | Create database schema | async, pollable |
| `get_servers_database_schemas` | `GET /orgs/{organization}/servers/{server}/database/schemas/{database}` | Get database schema | — |
| `delete_servers_database_schemas` | `DELETE /orgs/{organization}/servers/{server}/database/schemas/{database}` | Delete database schema | **destructive**, async, pollable |
| `create_servers_database_schemas_synchronizations` | `POST /orgs/{organization}/servers/{server}/database/schemas/synchronizations` | Update database schemas | async |
| `list_servers_database_users` | `GET /orgs/{organization}/servers/{server}/database/users` | List database users | — |
| `create_servers_database_users` | `POST /orgs/{organization}/servers/{server}/database/users` | Create database user | async, pollable |
| `get_servers_database_users` | `GET /orgs/{organization}/servers/{server}/database/users/{databaseUser}` | Get database user | — |
| `update_servers_database_users` | `PUT /orgs/{organization}/servers/{server}/database/users/{databaseUser}` | Update database user | async, pollable |
| `delete_servers_database_users` | `DELETE /orgs/{organization}/servers/{server}/database/users/{databaseUser}` | Delete database user | **destructive**, async, pollable |
| `update_servers_database_password` | `PUT /orgs/{organization}/servers/{server}/database/password` | Update the password for the database | — |

### Deployments

Forge documentation: https://forge.laravel.com/docs/sites/deployments

| Tool | Endpoint | Summary | Flags |
| --- | --- | --- | --- |
| `list_servers_sites_webhooks` | `GET /orgs/{organization}/servers/{server}/sites/{site}/webhooks` | List site webhooks | — |
| `create_servers_sites_webhooks` | `POST /orgs/{organization}/servers/{server}/sites/{site}/webhooks` | Create site webhook | async |
| `get_servers_sites_webhooks` | `GET /orgs/{organization}/servers/{server}/sites/{site}/webhooks/{deploymentWebhook}` | Get site webhook | — |
| `delete_servers_sites_webhooks` | `DELETE /orgs/{organization}/servers/{server}/sites/{site}/webhooks/{deploymentWebhook}` | Delete site webhook | async |
| `list_servers_sites_deployments` | `GET /orgs/{organization}/servers/{server}/sites/{site}/deployments` | List deployments | — |
| `create_servers_sites_deployments` | `POST /orgs/{organization}/servers/{server}/sites/{site}/deployments` | Create deployment | async, pollable |
| `get_servers_sites_deployments_status` | `GET /orgs/{organization}/servers/{server}/sites/{site}/deployments/status` | Get deployment status | — |
| `delete_servers_sites_deployments_status` | `DELETE /orgs/{organization}/servers/{server}/sites/{site}/deployments/status` | Update deployment state | async, pollable |
| `get_servers_sites_deployments_script` | `GET /orgs/{organization}/servers/{server}/sites/{site}/deployments/script` | Get deployment script | — |
| `update_servers_sites_deployments_script` | `PUT /orgs/{organization}/servers/{server}/sites/{site}/deployments/script` | Update deployment script | — |
| `get_servers_sites_deployments_deploy_hook` | `GET /orgs/{organization}/servers/{server}/sites/{site}/deployments/deploy-hook` | Get the deployment trigger URL | — |
| `update_servers_sites_deployments_deploy_hook` | `PUT /orgs/{organization}/servers/{server}/sites/{site}/deployments/deploy-hook` | Update deployment trigger URL | — |
| `create_servers_sites_deployments_push_to_deploy` | `POST /orgs/{organization}/servers/{server}/sites/{site}/deployments/push-to-deploy` | Create push to deploy configuration | async |
| `delete_servers_sites_deployments_push_to_deploy` | `DELETE /orgs/{organization}/servers/{server}/sites/{site}/deployments/push-to-deploy` | Delete push to deploy configuration | **confirm**, async |
| `get_servers_sites_deployments` | `GET /orgs/{organization}/servers/{server}/sites/{site}/deployments/{deployment}` | Get deployment | — |
| `get_servers_sites_deployments_log` | `GET /orgs/{organization}/servers/{server}/sites/{site}/deployments/{deployment}/log` | Get deployment output | — |
| `get_servers_sites_deploy_key` | `GET /orgs/{organization}/servers/{server}/sites/{site}/deploy-key` | Get deploy key | — |
| `create_servers_sites_deploy_key` | `POST /orgs/{organization}/servers/{server}/sites/{site}/deploy-key` | Create deploy key | async |
| `delete_servers_sites_deploy_key` | `DELETE /orgs/{organization}/servers/{server}/sites/{site}/deploy-key` | Delete deploy key | **destructive** |

### Firewall Rules

Forge documentation: https://forge.laravel.com/docs/resources/network

| Tool | Endpoint | Summary | Flags |
| --- | --- | --- | --- |
| `list_servers_firewall_rules` | `GET /orgs/{organization}/servers/{server}/firewall-rules` | List server firewall rules | — |
| `create_servers_firewall_rules` | `POST /orgs/{organization}/servers/{server}/firewall-rules` | Create server firewall rule | async, pollable |
| `get_servers_firewall_rules` | `GET /orgs/{organization}/servers/{server}/firewall-rules/{rule}` | Get server firewall rule | — |
| `delete_servers_firewall_rules` | `DELETE /orgs/{organization}/servers/{server}/firewall-rules/{rule}` | Delete server firewall rule | **confirm**, async, pollable |

### Integrations

| Tool | Endpoint | Summary | Flags |
| --- | --- | --- | --- |
| `get_servers_sites_integrations_horizon` | `GET /orgs/{organization}/servers/{server}/sites/{site}/integrations/horizon` | Get Laravel Horizon integration status | — |
| `create_servers_sites_integrations_horizon` | `POST /orgs/{organization}/servers/{server}/sites/{site}/integrations/horizon` | Create Laravel Horizon integration | async |
| `delete_servers_sites_integrations_horizon` | `DELETE /orgs/{organization}/servers/{server}/sites/{site}/integrations/horizon` | Delete Laravel Horizon integration | **confirm**, async |
| `get_servers_sites_integrations_octane` | `GET /orgs/{organization}/servers/{server}/sites/{site}/integrations/octane` | Get Laravel Octane integration status | — |
| `create_servers_sites_integrations_octane` | `POST /orgs/{organization}/servers/{server}/sites/{site}/integrations/octane` | Create Laravel Octane integration | async |
| `delete_servers_sites_integrations_octane` | `DELETE /orgs/{organization}/servers/{server}/sites/{site}/integrations/octane` | Delete Laravel Octane integration | **confirm**, async |
| `get_servers_sites_integrations_reverb` | `GET /orgs/{organization}/servers/{server}/sites/{site}/integrations/reverb` | Get Laravel Reverb integration status | — |
| `create_servers_sites_integrations_reverb` | `POST /orgs/{organization}/servers/{server}/sites/{site}/integrations/reverb` | Create Laravel Reverb integration | async |
| `delete_servers_sites_integrations_reverb` | `DELETE /orgs/{organization}/servers/{server}/sites/{site}/integrations/reverb` | Delete Laravel Reverb integration | **confirm**, async |
| `get_servers_sites_integrations_inertia` | `GET /orgs/{organization}/servers/{server}/sites/{site}/integrations/inertia` | Get Inertia integration status | — |
| `create_servers_sites_integrations_inertia` | `POST /orgs/{organization}/servers/{server}/sites/{site}/integrations/inertia` | Create Inertia integration | async |
| `get_servers_sites_integrations_pulse` | `GET /orgs/{organization}/servers/{server}/sites/{site}/integrations/pulse` | Get Laravel Pulse integration status | — |
| `create_servers_sites_integrations_pulse` | `POST /orgs/{organization}/servers/{server}/sites/{site}/integrations/pulse` | Create Laravel Pulse integration | async |
| `delete_servers_sites_integrations_pulse` | `DELETE /orgs/{organization}/servers/{server}/sites/{site}/integrations/pulse` | Delete Laravel Pulse integration | **confirm**, async |
| `get_servers_sites_integrations_laravel_maintenance` | `GET /orgs/{organization}/servers/{server}/sites/{site}/integrations/laravel-maintenance` | Get Laravel Maintenance integration status | — |
| `create_servers_sites_integrations_laravel_maintenance` | `POST /orgs/{organization}/servers/{server}/sites/{site}/integrations/laravel-maintenance` | Create Laravel Maintenance integration | **confirm**, async, pollable |
| `delete_servers_sites_integrations_laravel_maintenance` | `DELETE /orgs/{organization}/servers/{server}/sites/{site}/integrations/laravel-maintenance` | Delete Laravel Maintenance integration | async, pollable |
| `get_servers_sites_integrations_laravel_scheduler` | `GET /orgs/{organization}/servers/{server}/sites/{site}/integrations/laravel-scheduler` | Get Laravel Scheduler integration job | — |
| `create_servers_sites_integrations_laravel_scheduler` | `POST /orgs/{organization}/servers/{server}/sites/{site}/integrations/laravel-scheduler` | Create Laravel Scheduler integration job | async |
| `delete_servers_sites_integrations_laravel_scheduler` | `DELETE /orgs/{organization}/servers/{server}/sites/{site}/integrations/laravel-scheduler` | Delete Laravel Scheduler integration job | **confirm**, async |

### Logs

Forge documentation: https://forge.laravel.com/docs/sites/logs

| Tool | Endpoint | Summary | Flags |
| --- | --- | --- | --- |
| `get_servers_logs` | `GET /orgs/{organization}/servers/{server}/logs/{key}` | Get server log content | — |
| `delete_servers_logs` | `DELETE /orgs/{organization}/servers/{server}/logs/{key}` | Delete server log content | async |

### Monitors

Forge documentation: https://forge.laravel.com/docs/servers/monitoring

| Tool | Endpoint | Summary | Flags |
| --- | --- | --- | --- |
| `list_servers_monitors` | `GET /orgs/{organization}/servers/{server}/monitors` | List server monitors | — |
| `create_servers_monitors` | `POST /orgs/{organization}/servers/{server}/monitors` | Create server monitor | async, pollable |
| `get_servers_monitors` | `GET /orgs/{organization}/servers/{server}/monitors/{monitor}` | Get server monitor | — |
| `delete_servers_monitors` | `DELETE /orgs/{organization}/servers/{server}/monitors/{monitor}` | Delete server monitor | async, pollable |

### Nginx

Forge documentation: https://forge.laravel.com/docs/servers/nginx-templates

| Tool | Endpoint | Summary | Flags |
| --- | --- | --- | --- |
| `list_servers_nginx_templates` | `GET /orgs/{organization}/servers/{server}/nginx/templates` | List Nginx templates | — |
| `create_servers_nginx_templates` | `POST /orgs/{organization}/servers/{server}/nginx/templates` | Create Nginx template | — |
| `get_servers_nginx_templates` | `GET /orgs/{organization}/servers/{server}/nginx/templates/{nginxTemplate}` | Get Nginx template | — |
| `update_servers_nginx_templates` | `PUT /orgs/{organization}/servers/{server}/nginx/templates/{nginxTemplate}` | Update Nginx template | — |
| `delete_servers_nginx_templates` | `DELETE /orgs/{organization}/servers/{server}/nginx/templates/{nginxTemplate}` | Delete Nginx template | **confirm** |

### Organizations

Forge documentation: https://forge.laravel.com/docs/organizations

| Tool | Endpoint | Summary | Flags |
| --- | --- | --- | --- |
| `list_` | `GET /orgs` | List organizations | — |
| `get_` | `GET /orgs/{organization}` | Get organization | — |
| `list_server_credentials` | `GET /orgs/{organization}/server-credentials` | List server credentials | — |
| `get_server_credentials` | `GET /orgs/{organization}/server-credentials/{credential}` | Get server credential | — |
| `list_server_credentials_vpcs` | `GET /orgs/{organization}/server-credentials/{credential}/regions/{region}/vpcs` | List VPCs | — |
| `create_server_credentials_vpcs` | `POST /orgs/{organization}/server-credentials/{credential}/regions/{region}/vpcs` | Create a new VPC | — |
| `get_server_credentials_vpcs` | `GET /orgs/{organization}/server-credentials/{credential}/regions/{region}/vpcs/{vpcId}` | Get VPC | — |

### Providers

Forge documentation: https://forge.laravel.com/docs/server-providers

| Tool | Endpoint | Summary | Flags |
| --- | --- | --- | --- |
| `list_providers` | `GET /providers` | List providers | — |
| `get_providers` | `GET /providers/{provider}` | Get provider | — |
| `list_providers_sizes` | `GET /providers/{provider}/sizes` | List provider sizes | — |
| `get_providers_sizes` | `GET /providers/{provider}/sizes/{providerSize}` | Get provider size | — |
| `list_providers_regions` | `GET /providers/{provider}/regions` | List provider regions | — |
| `get_providers_regions` | `GET /providers/{provider}/regions/{providerRegion}` | Get provider region | — |
| `list_providers_regions_sizes` | `GET /providers/{provider}/regions/{providerRegion}/sizes` | List provider region sizes | — |
| `get_providers_regions_sizes` | `GET /providers/{provider}/regions/{providerRegion}/sizes/{providerSize}` | Get provider region size | — |

### Recipes

Forge documentation: https://forge.laravel.com/docs/recipes

| Tool | Endpoint | Summary | Flags |
| --- | --- | --- | --- |
| `list_recipes` | `GET /orgs/{organization}/recipes` | List organization recipes | — |
| `create_organization_recipes` | `POST /orgs/{organization}/recipes` | Create recipe | — |
| `get_recipes` | `GET /orgs/{organization}/recipes/{recipe}` | Get recipe | — |
| `update_recipes` | `PUT /orgs/{organization}/recipes/{recipe}` | Update recipe | — |
| `delete_recipes` | `DELETE /orgs/{organization}/recipes/{recipe}` | Delete recipe | — |
| `list_recipes_runs` | `GET /orgs/{organization}/recipes/{recipe}/runs` | List recipe runs | — |
| `create_recipes_runs` | `POST /orgs/{organization}/recipes/{recipe}/runs` | Create recipe run | async, pollable |
| `get_recipes_runs` | `GET /orgs/{organization}/recipes/{recipe}/runs/{log}` | Get recipe run | — |
| `list_teams_recipes` | `GET /orgs/{organization}/teams/{team}/recipes` | List team recipes | — |
| `create_teams_recipes` | `POST /orgs/{organization}/teams/{team}/recipes` | Share recipe with the team | **destructive** |
| `delete_teams_recipes` | `DELETE /orgs/{organization}/teams/{team}/recipes/{recipe}` | Delete a recipe share | **destructive** |
| `list_forge_recipes` | `GET /forge-recipes` | List Forge's recipes | — |
| `get_forge_recipes` | `GET /forge-recipes/{forgeRecipe}` | Get Forge recipe | — |
| `create_forge_recipes_runs` | `POST /forge-recipes/{forgeRecipe}/runs` | Create Forge recipe run | async |

### Redirect Rules

Forge documentation: https://forge.laravel.com/docs/sites/network

| Tool | Endpoint | Summary | Flags |
| --- | --- | --- | --- |
| `list_servers_sites_redirect_rules` | `GET /orgs/{organization}/servers/{server}/sites/{site}/redirect-rules` | List site redirect rules | — |
| `create_servers_sites_redirect_rules` | `POST /orgs/{organization}/servers/{server}/sites/{site}/redirect-rules` | Create site redirect rule | async, pollable |
| `get_servers_sites_redirect_rules` | `GET /orgs/{organization}/servers/{server}/sites/{site}/redirect-rules/{redirectRule}` | Get site redirect rule | — |
| `delete_servers_sites_redirect_rules` | `DELETE /orgs/{organization}/servers/{server}/sites/{site}/redirect-rules/{redirectRule}` | Delete site redirect rule | **confirm**, async, pollable |

### Roles

| Tool | Endpoint | Summary | Flags |
| --- | --- | --- | --- |
| `list_predefined_roles` | `GET /predefined-roles` | List predefined roles | — |
| `get_predefined_roles` | `GET /predefined-roles/{role}` | Get predefined role | — |
| `list_permissions` | `GET /permissions` | List permissions | — |
| `get_permissions` | `GET /permissions/{permission}` | Get permission | — |
| `list_roles` | `GET /orgs/{organization}/roles` | List roles | — |
| `create_roles` | `POST /orgs/{organization}/roles` | Create role | **destructive** |
| `get_roles` | `GET /orgs/{organization}/roles/{role}` | Get role | — |
| `update_roles` | `PUT /orgs/{organization}/roles/{role}` | Update role | **destructive** |
| `delete_roles` | `DELETE /orgs/{organization}/roles/{role}` | Delete role | **destructive** |
| `list_roles_permissions` | `GET /orgs/{organization}/roles/{role}/permissions` | List role permissions | — |

### SSH Keys

Forge documentation: https://forge.laravel.com/docs/ssh

| Tool | Endpoint | Summary | Flags |
| --- | --- | --- | --- |
| `list_servers_ssh_keys` | `GET /orgs/{organization}/servers/{server}/ssh-keys` | List server SSH keys | — |
| `create_servers_ssh_keys` | `POST /orgs/{organization}/servers/{server}/ssh-keys` | Create server SSH key | async, pollable |
| `get_servers_ssh_keys` | `GET /orgs/{organization}/servers/{server}/ssh-keys/{key}` | Get server SSH key | — |
| `delete_servers_ssh_keys` | `DELETE /orgs/{organization}/servers/{server}/ssh-keys/{key}` | Delete server SSH key | **destructive**, async, pollable |
| `get_servers_key` | `GET /orgs/{organization}/servers/{server}/key` | Get server public SSH key | — |
| `update_servers_key` | `PUT /orgs/{organization}/servers/{server}/key` | Update server public SSH key | — |

### Scheduled Jobs

Forge documentation: https://forge.laravel.com/docs/resources/scheduler

| Tool | Endpoint | Summary | Flags |
| --- | --- | --- | --- |
| `list_servers_scheduled_jobs` | `GET /orgs/{organization}/servers/{server}/scheduled-jobs` | List server scheduled jobs | — |
| `create_servers_scheduled_jobs` | `POST /orgs/{organization}/servers/{server}/scheduled-jobs` | Create scheduled job | async, pollable |
| `get_servers_scheduled_jobs` | `GET /orgs/{organization}/servers/{server}/scheduled-jobs/{job}` | Get scheduled job | — |
| `delete_servers_scheduled_jobs` | `DELETE /orgs/{organization}/servers/{server}/scheduled-jobs/{job}` | Delete scheduled job | **confirm**, async, pollable |
| `get_servers_scheduled_jobs_outputs` | `GET /orgs/{organization}/servers/{server}/scheduled-jobs/{job}/output` | Get scheduled job output | — |
| `list_servers_sites_scheduled_jobs` | `GET /orgs/{organization}/servers/{server}/sites/{site}/scheduled-jobs` | List site scheduled jobs | — |
| `create_servers_sites_scheduled_jobs` | `POST /orgs/{organization}/servers/{server}/sites/{site}/scheduled-jobs` | Create site scheduled job | async, pollable |
| `get_servers_sites_scheduled_jobs` | `GET /orgs/{organization}/servers/{server}/sites/{site}/scheduled-jobs/{job}` | Get site scheduled job | — |
| `delete_servers_sites_scheduled_jobs` | `DELETE /orgs/{organization}/servers/{server}/sites/{site}/scheduled-jobs/{job}` | Delete site scheduled job | **confirm**, async, pollable |
| `get_servers_sites_scheduled_jobs_outputs` | `GET /orgs/{organization}/servers/{server}/sites/{site}/scheduled-jobs/{job}/output` | Get site scheduled job output | — |

### Security Rules

Forge documentation: https://forge.laravel.com/docs/sites/network

| Tool | Endpoint | Summary | Flags |
| --- | --- | --- | --- |
| `list_servers_sites_security_rules` | `GET /orgs/{organization}/servers/{server}/sites/{site}/security-rules` | List site security rules | — |
| `create_servers_sites_security_rules` | `POST /orgs/{organization}/servers/{server}/sites/{site}/security-rules` | Create site security rule | async, pollable |
| `get_servers_sites_security_rules` | `GET /orgs/{organization}/servers/{server}/sites/{site}/security-rules/{securityRule}` | Get site security rule | — |
| `update_servers_sites_security_rules` | `PUT /orgs/{organization}/servers/{server}/sites/{site}/security-rules/{securityRule}` | Update site security rule | async, pollable |
| `delete_servers_sites_security_rules` | `DELETE /orgs/{organization}/servers/{server}/sites/{site}/security-rules/{securityRule}` | Delete site security rule | **confirm**, async, pollable |

### Server Credentials

| Tool | Endpoint | Summary | Flags |
| --- | --- | --- | --- |
| `list_teams_server_credentials` | `GET /orgs/{organization}/teams/{team}/server-credentials` | List team server credentials | — |
| `create_teams_server_credentials` | `POST /orgs/{organization}/teams/{team}/server-credentials` | Create a new server credential share | **destructive** |
| `delete_teams_server_credentials` | `DELETE /orgs/{organization}/teams/{team}/server-credentials/{credential}` | Delete a server credential share | **destructive** |

### Servers

Forge documentation: https://forge.laravel.com/docs/servers/the-basics

| Tool | Endpoint | Summary | Flags |
| --- | --- | --- | --- |
| `list_servers` | `GET /orgs/{organization}/servers` | List servers | — |
| `create_servers` | `POST /orgs/{organization}/servers` | Create server | async |
| `list_servers_archives` | `GET /orgs/{organization}/servers/archives` | List archived servers | — |
| `create_servers_archives` | `POST /orgs/{organization}/servers/archives` | Create an archived server | **destructive**, async |
| `delete_servers_archives` | `DELETE /orgs/{organization}/servers/archives/{server}` | Delete archived server | **confirm**, async |
| `create_servers_background_processes_actions` | `POST /orgs/{organization}/servers/{server}/background-processes/{backgroundProcess}/actions` | Perform an action on a server background process | **confirm**, async |
| `create_servers_actions` | `POST /orgs/{organization}/servers/{server}/actions` | Create server action | **confirm**, async |
| `create_servers_services_nginx_actions` | `POST /orgs/{organization}/servers/{server}/services/nginx/actions` | Perform Nginx action | **confirm**, async |
| `create_servers_services_postgres_actions` | `POST /orgs/{organization}/servers/{server}/services/postgres/actions` | Perform Postgres action | **confirm**, async |
| `create_servers_services_redis_actions` | `POST /orgs/{organization}/servers/{server}/services/redis/actions` | Perform Redis action | **confirm**, async |
| `create_servers_services_mysql_actions` | `POST /orgs/{organization}/servers/{server}/services/mysql/actions` | Perform MySQL action | **confirm**, async |
| `create_servers_services_php_actions` | `POST /orgs/{organization}/servers/{server}/services/php/actions` | Perform PHP action | **confirm**, async |
| `create_servers_services_supervisor_actions` | `POST /orgs/{organization}/servers/{server}/services/supervisor/actions` | Perform Supervisor action | **confirm**, async |
| `get_servers` | `GET /orgs/{organization}/servers/{server}` | Get server | — |
| `update_servers` | `PUT /orgs/{organization}/servers/{server}` | Update server | — |
| `delete_servers` | `DELETE /orgs/{organization}/servers/{server}` | Delete server | **destructive**, async |
| `get_servers_network` | `GET /orgs/{organization}/servers/{server}/network` | Get server network | — |
| `update_servers_network` | `PUT /orgs/{organization}/servers/{server}/network` | Update server network | async |
| `list_servers_events` | `GET /orgs/{organization}/servers/{server}/events` | List server events | — |
| `get_servers_events` | `GET /orgs/{organization}/servers/{server}/events/{event}` | Get server event | — |
| `get_servers_events_output` | `GET /orgs/{organization}/servers/{server}/events/{event}/output` | Get server event output | — |
| `get_servers_php_cli_version` | `GET /orgs/{organization}/servers/{server}/php/cli-version` | Get PHP CLI version | — |
| `update_servers_php_cli_version` | `PUT /orgs/{organization}/servers/{server}/php/cli-version` | Update PHP CLI version | async, pollable |
| `get_servers_php_site_version` | `GET /orgs/{organization}/servers/{server}/php/site-version` | Get PHP site version | — |
| `update_servers_php_site_version` | `PUT /orgs/{organization}/servers/{server}/php/site-version` | Update PHP site version | async, pollable |
| `list_servers_php_versions` | `GET /orgs/{organization}/servers/{server}/php/versions` | List PHP versions for server | — |
| `create_servers_php_versions` | `POST /orgs/{organization}/servers/{server}/php/versions` | Install new PHP version | async, pollable |
| `get_servers_php_versions` | `GET /orgs/{organization}/servers/{server}/php/versions/{phpVersion}` | Get PHP version | — |
| `update_servers_php_versions` | `PUT /orgs/{organization}/servers/{server}/php/versions/{phpVersion}` | Update installed PHP version | async, pollable |
| `delete_servers_php_versions` | `DELETE /orgs/{organization}/servers/{server}/php/versions/{phpVersion}` | Delete installed PHP version | **destructive**, async, pollable |
| `get_servers_php_versions_configs_fpm` | `GET /orgs/{organization}/servers/{server}/php/versions/{phpVersion}/configs/fpm` | Get PHP version FPM config | — |
| `update_servers_php_versions_configs_fpm` | `PUT /orgs/{organization}/servers/{server}/php/versions/{phpVersion}/configs/fpm` | Update PHP version FPM config | **confirm**, async |
| `get_servers_php_versions_configs_cli` | `GET /orgs/{organization}/servers/{server}/php/versions/{phpVersion}/configs/cli` | Get PHP version CLI config | — |
| `update_servers_php_versions_configs_cli` | `PUT /orgs/{organization}/servers/{server}/php/versions/{phpVersion}/configs/cli` | Update PHP version CLI config | **confirm**, async |
| `get_servers_php_versions_configs_pool` | `GET /orgs/{organization}/servers/{server}/php/versions/{phpVersion}/configs/pool` | Get PHP version pool config | — |
| `update_servers_php_versions_configs_pool` | `PUT /orgs/{organization}/servers/{server}/php/versions/{phpVersion}/configs/pool` | Update PHP version pool config | **confirm**, async |
| `get_servers_php_max_upload_size` | `GET /orgs/{organization}/servers/{server}/php/max-upload-size` | Get server PHP max upload size | — |
| `update_servers_php_max_upload_size` | `PUT /orgs/{organization}/servers/{server}/php/max-upload-size` | Update server PHP max upload size | async |
| `get_servers_php_max_execution_time` | `GET /orgs/{organization}/servers/{server}/php/max-execution-time` | Get server PHP max execution time | — |
| `update_servers_php_max_execution_time` | `PUT /orgs/{organization}/servers/{server}/php/max-execution-time` | Update server PHP max execution time | async |
| `get_servers_php_opcache` | `GET /orgs/{organization}/servers/{server}/php/opcache` | Get server PHP OPcache status | — |
| `create_servers_php_opcache` | `POST /orgs/{organization}/servers/{server}/php/opcache` | Create PHP OPcache config | async |
| `delete_servers_php_opcache` | `DELETE /orgs/{organization}/servers/{server}/php/opcache` | Delete PHP OPcache config | **confirm**, async |
| `list_teams_servers` | `GET /orgs/{organization}/teams/{team}/servers` | List team servers | — |
| `create_teams_servers` | `POST /orgs/{organization}/teams/{team}/servers` | Create a new server share | **destructive** |
| `delete_teams_servers` | `DELETE /orgs/{organization}/teams/{team}/servers/{server}` | Delete a server share | **destructive** |

### Sites

Forge documentation: https://forge.laravel.com/docs/sites/the-basics

| Tool | Endpoint | Summary | Flags |
| --- | --- | --- | --- |
| `list_sites` | `GET /sites` | List sites | — |
| `sites_index` | `GET /orgs/{organization}/sites` | List sites for Organization | — |
| `get_sites` | `GET /orgs/{organization}/sites/{site}` | Get site | — |
| `list_servers_sites` | `GET /orgs/{organization}/servers/{server}/sites` | List sites for server | — |
| `create_servers_sites` | `POST /orgs/{organization}/servers/{server}/sites` | Create site | async |
| `servers_sites_store_on_balancer` | `POST /orgs/{organization}/servers/{server}/sites/balancer` | Create site on a load balancer | async |
| `update_servers_sites` | `PUT /orgs/{organization}/servers/{server}/sites/{site}` | Update site | async |
| `delete_servers_sites` | `DELETE /orgs/{organization}/servers/{server}/sites/{site}` | Delete site | **destructive**, async |
| `list_servers_sites_certificates` | `GET /orgs/{organization}/servers/{server}/sites/{site}/certificates` | List site certificates | — |
| `list_servers_sites_domains` | `GET /orgs/{organization}/servers/{server}/sites/{site}/domains` | List domains | — |
| `create_servers_sites_domains` | `POST /orgs/{organization}/servers/{server}/sites/{site}/domains` | Create domain | async, pollable |
| `get_servers_sites_domains` | `GET /orgs/{organization}/servers/{server}/sites/{site}/domains/{domainRecord}` | Get domain | — |
| `update_servers_sites_domains` | `PATCH /orgs/{organization}/servers/{server}/sites/{site}/domains/{domainRecord}` | Update domain | async, pollable |
| `delete_servers_sites_domains` | `DELETE /orgs/{organization}/servers/{server}/sites/{site}/domains/{domainRecord}` | Delete domain | **confirm**, async, pollable |
| `servers_sites_domains_configurations` | `GET /orgs/{organization}/servers/{server}/sites/{site}/domains/{domainRecord}/configurations` | Get domain DNS configuration | — |
| `create_servers_sites_domains_actions` | `POST /orgs/{organization}/servers/{server}/sites/{site}/domains/{domainRecord}/actions` | Create domain action | **confirm**, async |
| `get_servers_sites_domains_nginx` | `GET /orgs/{organization}/servers/{server}/sites/{site}/domains/{domainRecord}/nginx` | Get domain Nginx configuration | — |
| `update_servers_sites_domains_nginx` | `PUT /orgs/{organization}/servers/{server}/sites/{site}/domains/{domainRecord}/nginx` | Update domain Nginx configuration | **confirm**, async |
| `get_servers_sites_domains_certificate` | `GET /orgs/{organization}/servers/{server}/sites/{site}/domains/{domainRecord}/certificate` | Get active domain certificate | — |
| `list_servers_sites_domains_certificates` | `GET /orgs/{organization}/servers/{server}/sites/{site}/domains/{domainRecord}/certificates` | List domain certificates | — |
| `create_servers_sites_domains_certificates` | `POST /orgs/{organization}/servers/{server}/sites/{site}/domains/{domainRecord}/certificates` | Create domain certificate | async, pollable |
| `servers_sites_domains_certificates_active` | `GET /orgs/{organization}/servers/{server}/sites/{site}/domains/{domainRecord}/certificates/active` | Get active domain certificate | — |
| `get_servers_sites_domains_certificates` | `GET /orgs/{organization}/servers/{server}/sites/{site}/domains/{domainRecord}/certificates/{certificate}` | Get domain certificate | — |
| `delete_servers_sites_domains_certificates` | `DELETE /orgs/{organization}/servers/{server}/sites/{site}/domains/{domainRecord}/certificates/{certificate}` | Delete domain certificate | **confirm**, async, pollable |
| `create_servers_sites_domains_certificates_actions` | `POST /orgs/{organization}/servers/{server}/sites/{site}/domains/{domainRecord}/certificates/{certificate}/actions` | Create domain certificate action | **confirm**, async |
| `get_servers_sites_healthcheck` | `GET /orgs/{organization}/servers/{server}/sites/{site}/healthcheck` | Get healthcheck endpoint | — |
| `update_servers_sites_healthcheck` | `PUT /orgs/{organization}/servers/{server}/sites/{site}/healthcheck` | Update healthcheck endpoint | — |
| `get_servers_sites_environment` | `GET /orgs/{organization}/servers/{server}/sites/{site}/environment` | Get .env content | — |
| `update_servers_sites_environment` | `PUT /orgs/{organization}/servers/{server}/sites/{site}/environment` | Update .env content | async |
| `get_servers_sites_nginx` | `GET /orgs/{organization}/servers/{server}/sites/{site}/nginx` | Get Nginx configuration | — |
| `update_servers_sites_nginx` | `PUT /orgs/{organization}/servers/{server}/sites/{site}/nginx` | Update Nginx configuration | **confirm**, async |
| `list_servers_sites_composer_credentials` | `GET /orgs/{organization}/servers/{server}/sites/{site}/composer/credentials` | Get composer credentials for the site | — |
| `create_servers_sites_composer_credentials` | `POST /orgs/{organization}/servers/{server}/sites/{site}/composer/credentials` | Create composer credentials for the site | async |
| `get_servers_sites_composer_credentials` | `GET /orgs/{organization}/servers/{server}/sites/{site}/composer/credentials/{repository}` | Get composer credential for the site | — |
| `update_servers_sites_composer_credentials` | `PUT /orgs/{organization}/servers/{server}/sites/{site}/composer/credentials/{repository}` | Update composer credentials for the site | async |
| `delete_servers_sites_composer_credentials` | `DELETE /orgs/{organization}/servers/{server}/sites/{site}/composer/credentials/{repository}` | Delete composer credentials for the site | async |
| `list_servers_sites_npm_credentials` | `GET /orgs/{organization}/servers/{server}/sites/{site}/npm/credentials` | Get NPM credentials for the site | — |
| `create_servers_sites_npm_credentials` | `POST /orgs/{organization}/servers/{server}/sites/{site}/npm/credentials` | Create NPM credentials for the site | async |
| `get_servers_sites_npm_credentials` | `GET /orgs/{organization}/servers/{server}/sites/{site}/npm/credentials/{registry}` | Get NPM credential for the site | — |
| `update_servers_sites_npm_credentials` | `PUT /orgs/{organization}/servers/{server}/sites/{site}/npm/credentials/{registry}` | Update NPM credentials for the site | async |
| `delete_servers_sites_npm_credentials` | `DELETE /orgs/{organization}/servers/{server}/sites/{site}/npm/credentials/{registry}` | Delete npm credentials for the site | async |
| `list_servers_sites_load_balancing_nodes` | `GET /orgs/{organization}/servers/{server}/sites/{site}/load-balancing-nodes` | List load balancing nodes | — |
| `update_servers_sites_load_balancing_nodes` | `PUT /orgs/{organization}/servers/{server}/sites/{site}/load-balancing-nodes` | Update load balancing nodes | async |
| `get_servers_sites_logs_nginx_access` | `GET /orgs/{organization}/servers/{server}/sites/{site}/logs/nginx-access` | Get Nginx access log content | — |
| `delete_servers_sites_logs_nginx_access` | `DELETE /orgs/{organization}/servers/{server}/sites/{site}/logs/nginx-access` | Delete Nginx access log content | async |
| `get_servers_sites_logs_nginx_error` | `GET /orgs/{organization}/servers/{server}/sites/{site}/logs/nginx-error` | Get Nginx error log content | — |
| `delete_servers_sites_logs_nginx_error` | `DELETE /orgs/{organization}/servers/{server}/sites/{site}/logs/nginx-error` | Delete Nginx error log content | async |
| `get_servers_sites_logs_application` | `GET /orgs/{organization}/servers/{server}/sites/{site}/logs/application` | Get site log content | — |
| `delete_servers_sites_logs_application` | `DELETE /orgs/{organization}/servers/{server}/sites/{site}/logs/application` | Delete site log content | async |
| `list_servers_sites_heartbeats` | `GET /orgs/{organization}/servers/{server}/sites/{site}/heartbeats` | List heartbeats | — |
| `create_servers_sites_heartbeats` | `POST /orgs/{organization}/servers/{server}/sites/{site}/heartbeats` | Create heartbeat | — |
| `get_servers_sites_heartbeats` | `GET /orgs/{organization}/servers/{server}/sites/{site}/heartbeats/{heartbeat}` | Get heartbeat | — |
| `update_servers_sites_heartbeats` | `PUT /orgs/{organization}/servers/{server}/sites/{site}/heartbeats/{heartbeat}` | Update heartbeat | — |
| `delete_servers_sites_heartbeats` | `DELETE /orgs/{organization}/servers/{server}/sites/{site}/heartbeats/{heartbeat}` | Delete heartbeat | — |

### Storage Providers

Forge documentation: https://forge.laravel.com/docs/storage-providers

| Tool | Endpoint | Summary | Flags |
| --- | --- | --- | --- |
| `list_storage_providers` | `GET /orgs/{organization}/storage-providers` | List storage providers | — |
| `create_storage_providers` | `POST /orgs/{organization}/storage-providers` | Create storage provider | — |
| `get_storage_providers` | `GET /orgs/{organization}/storage-providers/{storageConfiguration}` | Get storage provider | — |
| `update_storage_providers` | `PUT /orgs/{organization}/storage-providers/{storageConfiguration}` | Update storage provider | async |
| `delete_storage_providers` | `DELETE /orgs/{organization}/storage-providers/{storageConfiguration}` | Delete storage provider | **destructive** |

### Teams

Forge documentation: https://forge.laravel.com/docs/teams

| Tool | Endpoint | Summary | Flags |
| --- | --- | --- | --- |
| `list_teams` | `GET /orgs/{organization}/teams` | List teams | — |
| `create_teams` | `POST /orgs/{organization}/teams` | Create team | **destructive** |
| `get_teams` | `GET /orgs/{organization}/teams/{team}` | Get team | — |
| `update_teams` | `PUT /orgs/{organization}/teams/{team}` | Update team | **destructive** |
| `delete_teams` | `DELETE /orgs/{organization}/teams/{team}` | Delete team | **destructive** |
| `list_teams_members` | `GET /orgs/{organization}/teams/{team}/members` | List team members | — |
| `get_teams_members` | `GET /orgs/{organization}/teams/{team}/members/{user}` | Get team member | — |
| `update_teams_members` | `PUT /orgs/{organization}/teams/{team}/members/{user}` | Update team member | **destructive** |
| `delete_teams_members` | `DELETE /orgs/{organization}/teams/{team}/members/{user}` | Delete team member | **destructive** |
| `list_teams_invites` | `GET /orgs/{organization}/teams/{team}/invites` | List team invitations | — |
| `create_teams_invites` | `POST /orgs/{organization}/teams/{team}/invites` | Create team invite | **destructive**, async |
| `get_teams_invites` | `GET /orgs/{organization}/teams/{team}/invites/{invitation}` | Get team invitation | — |
| `delete_teams_invites` | `DELETE /orgs/{organization}/teams/{team}/invites/{invitation}` | Delete team invitation | **destructive** |

### User

| Tool | Endpoint | Summary | Flags |
| --- | --- | --- | --- |
| `get_user` | `GET /user` | Get user | — |
| `me` | `GET /me` | Get user | — |

