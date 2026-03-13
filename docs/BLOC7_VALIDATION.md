# Bloc 7 — validation et non-régression

## 1. Préparation
- déployer l'API
- exécuter le SQL `services/api/sql/2026-03-13-bloc7-tenant-events.sql`
- ouvrir le staff et vérifier `/health`
- lancer `node services/api/scripts/smoke-test.js https://TON-API`

## 2. Flux métier à revalider
1. nouvelle commande sur table vide
2. table active correctement visible
3. impression ticket
4. passage en préparation
5. passage à encoder en caisse
6. confirmation caisse
7. clôture normale
8. table redevenue vide
9. session visible dans résumé, historique et manager summary
10. même scénario avec clôture anomalie
11. ancienne commande qui revient => table réactivée correctement

## 3. Diagnostic à vérifier
- `/diagnostic/overview` répond avec `ok: true`
- `/diagnostic/events` répond avec une liste d'événements
- les actions staff créent des événements cohérents
- les erreurs renvoient un `error.code` stable et un `requestId`

## 4. Signaux de régression
- statut `Clôturée` visible dans le tableau principal
- table vide avec ancienne commande affichée comme active
- `/summary` sans `totals`
- `/history-sessions` incohérent avec le résumé
- `/diagnostic/events` vide alors que le SQL a bien été exécuté et que des actions viennent d'être faites
