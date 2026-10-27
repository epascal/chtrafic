# GraphHopper Docker et datafeed (trafic)

## Image `israelhikingmap/graphhopper:10.0`

Cette image est construite à partir du dépôt officiel [graphhopper/graphhopper](https://github.com/graphhopper/graphhopper). Elle fournit le moteur de routage (car, hike, mtb, etc.) mais **ne contient pas** le module trafic temps réel ni l’endpoint **POST /datafeed**.

Donc avec cette image seule, le script `push-graphhopper.ts` ne peut pas envoyer les données TomTom : l’appel à `/datafeed` renverra 404.

## Options pour avoir le datafeed

### 1. Image / build personnalisé avec traffic

L’endpoint `/datafeed` et le traitement du trafic viennent du projet (archivé) [karussell/graphhopper-traffic-data-integration](https://github.com/karussell/graphhopper-traffic-data-integration). Pour avoir le datafeed il faut une instance GraphHopper basée sur ce projet (ou un fork qui l’intègre).

Vous pouvez :

- **Forker** `graphhopper-traffic-data-integration`, le faire compiler avec une version récente de GraphHopper si besoin, puis construire une image Docker à partir de ce build (JAR + config qui expose `/datafeed`).
- Vérifier s’il existe une image Docker tierce qui inclut déjà ce module (aucune image « officielle » ou israelhikingmap avec traffic n’est connue à ce jour).

### 2. Utiliser `israelhikingmap/graphhopper` pour le routage uniquement

Sans datafeed, vous pouvez continuer à utiliser `israelhikingmap/graphhopper:10.0` pour le routage classique (sans vitesses trafic mises à jour). Les scripts `fetch-tomtom.ts` et `fetch-tomtom-tiles.ts` restent utiles pour visualiser le trafic (ex. `tomtom.html`, `tomtom-tiles.html`).

### 3. Variable d’environnement pour votre instance

Quand vous aurez une instance qui expose `/datafeed` (votre propre build ou une autre image) :

```bash
export GRAPHHOPPER_URL=http://localhost:8989   # ou l’URL de votre serveur
npm run push:graphhopper
```

Ou en une ligne :

```bash
GRAPHHOPPER_URL=http://votre-serveur:8989 npx tsx src/push-graphhopper.ts
```

## Résumé

| Composant                         | israelhikingmap/graphhopper:10.0 | Instance avec traffic (ex. karussell) |
|----------------------------------|----------------------------------|----------------------------------------|
| Routage (car, hike, mtb, etc.)   | Oui                              | Oui                                    |
| POST /datafeed (trafic temps réel) | Non                            | Oui                                    |
| GET /roads (visualisation trafic) | Non                            | Oui                                    |

Pour envoyer les tuiles TomTom vers GraphHopper, il faut une instance qui inclut le module traffic et expose `/datafeed` ; l’image Docker `israelhikingmap/graphhopper:10.0` ne le fait pas par défaut.

---

## Repréparation périodique (CH + trafic)

Quand on utilise les **Contraction Hierarchies (CH)** et le **datafeed** en même temps, les vitesses des arêtes changent en mémoire mais les **données CH (raccourcis, niveaux)** ont été calculées avec les anciennes vitesses. Pour que les routes reflètent le trafic à jour tout en restant rapides avec CH, il faut **recalculer la préparation CH** après (ou périodiquement avec) les mises à jour du datafeed. C’est ce qu’on appelle la **repréparation périodique**.

### Principe

1. **Import initial** : chargement OSM + première préparation CH (une fois au démarrage ou à l’import).
2. **Mise à jour trafic** : POST vers `/datafeed` → les vitesses des arêtes sont modifiées en mémoire.
3. **Repréparation** : relancer l’algorithme de préparation CH sur le graphe **déjà en mémoire** (sans re-importer OSM). Il recalcule les raccourcis et l’ordre des nœuds avec les nouvelles vitesses. Durée typique : de quelques secondes (petite zone) à plusieurs minutes (ex. ~9 min pour l’Allemagne).
4. **Routage** : jusqu’à la prochaine repréparation, les requêtes utilisent ce CH à jour → routes cohérentes avec le trafic pour cette « fenêtre ».

En « périodique », on enchaîne par exemple : toutes les 5–10 min, recevoir le datafeed → mettre à jour le graphe → lancer la repréparation → une fois terminée, le serveur sert des routes à jour jusqu’au prochain cycle.

### En pratique avec le GraphHopper open source

- Le **GraphHopper standard** ne propose pas d’API publique pour « relancer uniquement la préparation CH » sur le graphe déjà chargé. La préparation a lieu au démarrage (ou à l’import), pas à la demande.
- Le projet **graphhopper-traffic-data-integration** mentionne qu’avec le mode « speed » (CH) il faudrait « prepare the data again » après chaque mise à jour (d’où le « near-real-time »), mais il ne décrit pas de mécanisme automatique de repréparation dans le code public.

Donc la repréparation périodique peut être réalisée de l’une des manières suivantes (selon ce qu’on est prêt à coder ou déployer) :

| Approche | Description | Limites |
|----------|-------------|--------|
| **Fork / module custom** | Ajouter dans GraphHopper (ou un fork) un endpoint ou un job qui, après mise à jour du graphe par le datafeed, appelle en interne la préparation CH puis bascule le routage sur le nouveau CH. | Nécessite de modifier le code Java et de maintenir un fork. |
| **Redémarrage périodique** | Toutes les X minutes : arrêter le serveur, recharger (le graphe sur disque est inchangé), ré-envoyer le datafeed, puis relancer la préparation. Les données datafeed sont en mémoire donc perdues au restart ; il faut les ré-appliquer après chaque démarrage. | Downtime à chaque cycle, et la préparation au démarrage peut être lente. |
| **Deux instances (blue/green)** | Instance A sert le trafic. En parallèle, instance B charge le même graphe, reçoit le même datafeed, lance la préparation. Quand B est prête, on bascule le trafic vers B ; A peut alors être mise à jour pour le prochain cycle. | Plus complexe à déployer (deux processus, bascule de trafic, possiblement load balancer). |
| **Mode flexible (sans CH)** | Ne pas utiliser CH pour les profils « avec trafic ». Les requêtes lisent directement les vitesses à jour du graphe ; pas de repréparation. | Requêtes plus lentes qu’avec CH. |

En résumé : la **repréparation périodique** est l’idée de recalculer la couche CH à intervalle régulier après mise à jour du trafic pour garder à la fois la rapidité CH et la prise en compte du trafic. Dans le projet open source actuel, cela implique soit du code custom (fork / endpoint de repréparation), soit une organisation en redémarrages ou double instance, car il n’y a pas d’API « re-prepare CH » prête à l’emploi.
