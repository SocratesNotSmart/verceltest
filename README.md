# ZTL Radaras

Interaktyvus žemėlapis, kuris seka tavo vietą Italijoje ir įspėja **prieš** įvažiuojant į
ZTL (*zona a traffico limitato*) arba LEZ (*Area B/C*, mažos taršos) zoną.

Statinis PWA – jokio backend'o, jokių paskyrų. Veikia telefono naršyklėje, o įsidiegus
į pradinį ekraną – ir be interneto.

*An interactive map that tracks your position in Italy and warns you before you drive into
a limited traffic zone (ZTL) or low emission zone. Static PWA, no backend, works offline.*

---

## Ką daro

| | |
|---|---|
| 🟢 **ŠVARU** | šalia ZTL zonų nėra |
| 🟡 **ARTĖJI** | zona arčiau nei nustatytas spindulys (numatytai 300 m) **arba** pagal greitį ir kryptį į ją įvažiuosi per artimiausias ~12 s |
| 🔴 **ESI ZONOJE** | tavo koordinatės yra zonos viduje |

Perėjus į geltoną ar raudoną būseną suveikia garsinis signalas, vibracija ir balso
įspėjimas (lietuvių / anglų / italų). Raudona būsena kartojama kas 60 s, kol išvažiuoji.

Papildomai:

- **Kryptinė prognozė** – tikrinamas ne tik dabartinis taškas, bet ir maršruto atkarpa
  priekyje (kas 50 m), todėl siaura zona skersai kelio irgi pagaunama. Važiuojant tolyn
  nuo zonos įspėjimas nesuveikia.
- **GPS tikslumo atsarga** – įspėjimo atstumas mažinamas signalo paklaidos dydžiu.
- **Darbo laikas** – rodoma, ar zona šiuo metu veikia (Italijos laiku), pagal OSM
  `opening_hours`. Neaiškus grafikas visada laikomas **aktyviu**.
- **Zonos paieška pagal miestą** – įvedi „Firenze“, programa atsisiunčia to miesto zonas.
- **Offline** – atsisiųstos zonos saugomos IndexedDB, žemėlapio kaladėlės – Cache
  Storage. Galima iš anksto atsisiųsti **visą Italiją** vienu mygtuku.
- **Ekranas neužgęsta** važiuojant (Wake Lock API).
- **Bandymo režimas** – įjungus galima spausti žemėlapį ir „važinėti“ be GPS.

## Iš kur duomenys

Zonos imamos gyvai iš [OpenStreetMap](https://www.openstreetmap.org/) per
[Overpass API](https://overpass-api.de/). Ieškoma trijų dalykų:

- `boundary=limited_traffic_zone` – oficiali ZTL žymėjimo schema;
- `boundary=low_emission_zone` – LEZ / Area B / Area C;
- uždarų plotų, kurių `name` atitinka `ZTL`, `Zona a Traffico Limitato`, `Area B/C`
  (senesni žymėjimai).

Naudojami trys Overpass veidrodžiai iš eilės, kol vienas atsako.

> [!WARNING]
> **OSM duomenys nėra oficialūs ir nėra pilni.** Ne kiekvienas Italijos miestas turi
> nubraižytą ZTL poligoną, o kai kurie yra pasenę. Ši programa yra pagalbinė priemonė,
> o ne garantija – **visada sek kelio ženklus ir kamerų įspėjimus.** Už baudą atsakingas
> vairuotojas, ne žemėlapis.

Dėl to programa sąmoningai klysta į saugiąją pusę: nežinomas grafikas = zona aktyvi,
neatpažinta `opening_hours` sintaksė = zona aktyvi, GPS paklaida pridedama prie zonos.

## Kaip naudotis

1. Atsidaryk puslapį telefone (Chrome / Safari).
2. **Bendrinti → Pridėti į pradinį ekraną** – kad veiktų per visą ekraną ir be interneto.
3. Nustatymuose paspausk **🇮🇹 Italia** ir palauk – atsisiųs visos šalies zonas
   (užtrunka iki poros minučių, po to interneto nebereikia).
4. Sėsdamas į mašiną spausk **Pradėti sekimą** ir leisk naudoti vietą.

Garsas mobiliuosiuose įsijungia tik po paspaudimo – todėl pirmas „Pradėti sekimą“
paspaudimas yra būtinas, kad įspėjimai skambėtų.

## Paleidimas lokaliai

Reikia HTTPS arba `localhost` – kitaip naršyklė neduos nei geolokacijos, nei service worker'io.

```bash
npx serve .          # arba: python3 -m http.server 8000
```

Tada atidaryk <http://localhost:3000>.

## Deploy

Statiniai failai repo šaknyje – Vercel juos aptarnauja be jokio build'o.
`vercel.json` nustato `Permissions-Policy` (geolokacija, wake lock) ir cache antraštes.

## Struktūra

```
index.html                 karkasas
app/main.js                būsenų mašina, žemėlapis, UI
app/geo.js                 point-in-polygon, atstumai, prognozė
app/hours.js               konservatyvus opening_hours skaitytuvas
app/overpass.js            Overpass užklausos + multipoligonų surinkimas
app/store.js               IndexedDB (zonos + atsisiųstų sričių sąrašas)
app/alerts.js              garsas, vibracija, balsas, Wake Lock
app/i18n.js                LT / EN / IT
sw.js                      offline: app shell + žemėlapio kaladėlės
vendor/leaflet/            Leaflet 1.9.4 (vietinis, kad veiktų offline)
```

## Licencijos

Kodas – MIT. Žemėlapio ir zonų duomenys – © OpenStreetMap prisidėjusieji,
[ODbL](https://www.openstreetmap.org/copyright). Leaflet – BSD-2-Clause.
