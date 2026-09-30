# Ma Station Météo — application web

Application web installable (PWA) qui affiche les mesures de la station
en direct et leur historique. Elle lit Firebase en **lecture seule** :
aucun mot de passe ni secret dans ces fichiers, ils peuvent être publics.

⚠️ Ne mets sur GitHub **que ce dossier** `appli_web`. Les codes Arduino
contiennent ton mot de passe WiFi et le secret Firebase.

## Contenu

| Fichier | Rôle |
|---|---|
| `index.html` | la page |
| `app.js` | lecture de Firebase, cartes, graphes |
| `style.css` | le style (fond noir, couleurs de la station) |
| `manifest.webmanifest`, `icons/` | ce qui la rend installable comme une appli |
| `sw.js` | garde l'appli en cache pour qu'elle s'ouvre vite |
| `lib/` | uPlot, la bibliothèque des graphes (licence MIT) |

## 1. Règles Firebase (une fois)

Console Firebase → **Realtime Database** → onglet **Règles** :

```json
{
  "rules": {
    ".read": true,
    ".write": false
  }
}
```

puis **Publier**. L'appli peut lire, personne ne peut écrire depuis Internet ;
la station continue d'écrire grâce à son secret.

## 2. Mise en ligne sur GitHub Pages (gratuit)

1. Sur github.com : **New repository** → nom `station-meteo` → **Public** → *Create repository*.
2. Sur la page du dépôt : **Add file → Upload files**, glisse **le contenu** du dossier
   `appli_web` (les fichiers et les dossiers `icons` et `lib`, pas le dossier lui-même),
   puis **Commit changes**.
3. **Settings → Pages** → *Source* : **Deploy from a branch** → branche **main**, dossier **/ (root)** → **Save**.
4. Après une minute, l'adresse s'affiche en haut de cette page :
   `https://<ton-nom-github>.github.io/station-meteo/`

Pour une mise à jour plus tard : ré-uploade les fichiers modifiés de la même façon.

## 3. Installer l'appli

- **iPhone** : ouvre l'adresse dans **Safari** → bouton **Partager** → **Sur l'écran d'accueil**.
- **Mac** : dans **Safari**, menu **Fichier → Ajouter au Dock** ;
  ou dans **Chrome**, l'icône d'installation à droite de la barre d'adresse.

## Ce que l'appli affiche

- **Accueil** : chaque mesure en direct, avec sa courbe et son min / max des dernières 24 h.
  En haut à droite, depuis quand chaque station a donné des nouvelles.
- **En touchant une mesure** :
  - *Évolution détaillée* : 1 point toutes les 5 minutes, sur 24 h, 3, 5 ou 30 jours
    (glisser pour zoomer, double-toucher pour revenir) ;
  - *Historique complet* : le max et le min de chaque jour depuis le début, avec les records.

Les nouvelles mesures ajoutées sur la station extérieure apparaissent toutes seules.

## Organisation des données dans Firebase

| Chemin | Contenu |
|---|---|
| `/direct/int` | intérieur en temps réel (toutes les 15 s) |
| `/direct/ext` | dernier paquet de la station extérieure |
| `/h5/<clé>/<case>` | moyenne sur 5 min, anneau de 30 jours |
| `/resume/<clé>/<date>` | min / max / moyenne de chaque jour, gardés pour toujours |

Clés intérieures : `temp`, `hum`, `co2`, `pm10` (= PM 1.0), `pm25`, `pm100` (= PM 10).
Clés extérieures : `ext_` + nom de la tuile sans accents (`ext_temperature`, `ext_lumiere`…).

Les anciens emplacements `/meteo` et `/mesures` (ancienne version de la station) ne sont
plus écrits : tu pourras les supprimer dans la console Firebase une fois tout en place.

Pour tester l'appli avec une autre base : `index.html?db=https://...`
