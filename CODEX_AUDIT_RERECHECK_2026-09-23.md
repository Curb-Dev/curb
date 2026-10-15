# CURB ayrıntılı yeniden audit raporu — 23 Eylül 2026

## 1. Yönetici özeti

Bu çalışma, CURB kod tabanının güncel `master` anlık görüntüsünü kontrat güvenliği,
muhasebe, Uniswap entegrasyonu, çoklu quote asset dağıtımı, tarayıcı işlem bütünlüğü
ve mainnet hazırlığı açısından yeniden denetler. **Bu audit hiçbir bulguyu düzeltmedi ve
hiçbir ürün dosyasını değiştirmedi.** Eşzamanlı başka çalışma tarafından gelen geç UI
değişiklikleri ayrıca kapsamda işaretlenmiştir; bu dosya yalnız audit çıktısıdır.

### Sonuç

- **Kritik:** 0
- **Yüksek:** 3
  - 1 kalıcı mainnet parametresi/doğrulama engeli
  - 1 bilinçli kabul edilmiş yüksek ekonomik risk
  - 1 harici issuer kaynaklı yüksek liveness riski
- **Orta:** 8
- **Düşük:** 5
- **Bilgi / hazırlık:** 4

Bu anlık görüntüde izinsiz bir saldırganın curve rezervlerini veya kilitli LP
anaparasını doğrudan çalabildiği bir yol bulmadım. Önceki auditin iki yüksek
swap-DoS yolu ile yanlış ölçeklenmiş dev-buy yolu güncel kodda kapalıdır. Buna
karşılık **mainnet dağıtımı güvenli biçimde hazır değildir**: kalıcı çoklu-varlık
eşikleri kendi test fixture'larıyla uyuşmuyor; oracle/reference-deviation koruması
bilinçli olarak yok; Safe ve canonical deployment kontrolleri kapanmamış durumda.

En önemli yeni bulgu, test başarısının kapsamıdır. Tam paket yeşil olmasına rağmen
deploy script'indeki 11 quote asset'in yalnız WETH'i lifecycle testinde aynı eşik
değeriyle çalıştırılıyor. Deploy yorumları ayrıca aynı blokta yapılan yeniden
türetmenin yedi varlığın beşinde 3–4 kat ayrıştığını ve sebebin çözülmediğini
söylüyor. Bu değerler factory başına kalıcı olduğundan, ölçüm tekrar kurulmadan
mainnet dağıtımı yapılmamalıdır.

Audit kapanışı sırasında çalışma ağacına eşzamanlı olarak eklenen, henüz commit edilmemiş
form-clamp değişikliği ayrıca güncel browser paketini kırdı: limit üstü developer buy
reddedilmek yerine alan içinde azami tutara çevriliyor ve geçerli işlem olarak gönderiliyor.
Bu rapor bu geç değişikliği de kapsar; başlangıçtaki yeşil browser sonucu güncel çalışma
ağacının sonucu olarak sunulmaz.

## 2. Kapsam ve sabitlenen anlık görüntü

- Git HEAD: `d63a7f8d89d6eba34dcf4210eb4a2aad2a3ad3fe`
- Dal: `master`
- Son üç commit:
  - `d63a7f8d` — audit kapanış kaydı
  - `6176e05e` — arayüz ölçek/limit/claim/route değişiklikleri
  - `b022d70d` — fee recipient teslimatının swap'ten ayrılması
- Kritik dosya SHA-256 değerleri:
  - `src/curb/FeeHook.sol`: `26BE5CA22BD539D712EF0959252465E9B4D779805995AFD8E4016879C4D496FF`
  - `src/curb/CurbLaunchFactory.sol`: `338C28A45D910DB51815D2AB8B3DCCA9CA0AA2E6A63920A85E17DBB063714B9B`
  - `src/curb/LaunchRegistry.sol`: `B8CE3470E6C417D46F03907112CE826005F8F3304AE1A7A0C0D0B7C6546EC9BC`
  - `src/curb/Graduator.sol`: `0548FAD65D7ABF68786F45A1E69C8C0D14EFF9389115794C20CF858E561E7719`
  - `src/curb/FeeEscrow.sol`: `5B8725A1107444DF2C18771D912244C55AC60CCCD0C22ED96E014D278743A1D4`
  - `src/curb/LaunchLens.sol`: `2BD666A17BA761E5D32D8ADC88CA3308373067673B5A453C8C397054D377ECD6`
  - `web/app.js` (audit başlangıcı): `194C4346E0AC2A628FA6345942AE9E88598C8F08F88D5A4BCFDCDDD747F6EBAD`
  - `web/app.js` (audit kapanışı, commit edilmemiş eşzamanlı değişiklik): `4CE885F4D446BE1C56027E47A907F0E49F0C4DD933E71EB99721A082388CF288`
  - `web/e2e/app.spec.js` (audit kapanışı): `6BAF3D12AAE11B93351B331B2E93CE6C7462C3BFAC894B69CB702084C2272AEC`
  - `web/app.html` (audit kapanışı): `4830F85EF576AD41758B2FB54E36B701B9C8196569962021470F98EF75406BA4`
  - `script/DeployCurb.s.sol`: `156C5FC9FE99F79B0FA5783BFE83BE1B11A0F59BC90388E227F509D5D35293F9`

İncelenen yüzeyler:

- `src/curb/` altındaki factory, registry, hook, graduator, escrow, policy, lock,
  token ve lens kontratları
- vendored `PonsV2BondingCurve`
- Uniswap v4 PoolManager/hook ve UniversalRouter etkileşimleri
- çoklu quote asset deploy akışı ve mainnet preflight
- tarayıcı create, curve, pool, ETH route, receipt reconciliation ve recovery yolları
- fork, non-fork ve Playwright testlerinin güncel iddiaları
- proje kayıtları: `PRE_MAINNET.txt`, `FEE_POLICY.txt`, `DEPTH.txt`, `DEPLOY.txt`

Hariç kalanlar:

- Hukuki/BUSL görüşü
- Bağımsız üçüncü taraf audit yerine geçecek bir sertifikasyon
- Mainnet deployment ve explorer doğrulaması
- MEV/sandwich simülasyonu ve piyasa talebi tahmini
- Slither: bu ortamda kurulu olmadığı için çalıştırılamadı

## 3. Bağımsız doğrulama

Audit sırasında aşağıdaki paketleri ayrı ve izole koşullarda çalıştırdım:

| Kontrol | Sonuç |
|---|---:|
| Non-fork Foundry | **61 geçti, 0 kaldı** |
| Pinlenmiş Base fork Foundry | **274 geçti, 0 kaldı** |
| Playwright, audit başlangıç anlık görüntüsü | **64 geçti, 0 kaldı** |
| Playwright, audit kapanışındaki güncel çalışma ağacı | **61 geçti, 1 düştü, 3 çalışmadı** |
| Güncel kontrat testleri toplamı | **335 geçti, 0 kaldı** |

Başlangıç browser sonucu, kapanış sırasında eklenen commit edilmemiş form değişikliklerini
kapsamaz. Güncel tekrar koşusunda düşen test `app.spec.js:2934` olup limit üstü developer
buy'ın gönderildiğini doğrudan saptadı. Fork ve browser koşuları ayrı portlarda kendi node'larıyla çalıştırıldı; audit node'u
sonunda durduruldu ve port claim'i bırakıldı. Mainnet'e işlem gönderilmedi.

`forge build --sizes --skip test --skip script` başarılıdır. Runtime boyutları:

| Kontrat | Runtime bytes | EIP-170 marjı |
|---|---:|---:|
| CurbLaunchFactory | 21.215 | 3.361 |
| Graduator | 12.878 | 11.698 |
| FeeHook | 8.714 | 15.862 |
| LaunchRegistry | 4.717 | 19.859 |
| LaunchLens | 3.323 | 21.253 |
| PositionLock | 3.022 | 21.554 |
| FeeEscrow | 2.848 | 21.728 |

Yeşil test sonucu aşağıdaki bulguları geçersiz kılmaz. Özellikle H-01'de test
fixture'ı deploy edilecek parametrelerle aynı değildir.

## 4. Önem tablosu

| Kimlik | Önem | Başlık | Tür |
|---|---|---|---|
| H-01 | Yüksek | Çoklu-varlık eşikleri çözümlenmemiş ölçüme dayanıyor ve deploy değerleri lifecycle testleriyle uyuşmuyor | Mainnet/economic invariant |
| H-02 | Yüksek | RWA fiyatı için oracle, staleness, reference-deviation veya hafta sonu modu yok | Bilinçli ekonomik risk |
| H-03 | Yüksek | Issuer policy/pause, curve graduation ve fee claim liveness'ını kalıcı olarak durdurabilir | Harici bağımlılık |
| M-01 | Orta | Havuz platform payı canlı ve değişebilirken UI ve belgeler sabit %0,5 vaat ediyor | Ekonomik açıklama |
| M-02 | Orta | Deploy/preflight, istenen Safe sahiplerini ve eşiğini zorlamıyor; policy owner deployer'a düşebiliyor | Operasyon/yetki |
| M-03 | Orta | Registry deployer süresiz, gecikmesiz ve geri alınamaz launcher ekleme yetkisine sahip | Governance |
| M-04 | Orta | Hosted UI canonical chain/deployment/codehash doğrulaması yapmıyor | Kimlik/phishing |
| M-05 | Orta | USDC iki-hop rota araması yalnız tek tier kombinasyonunu değerlendiriyor | Ekonomik routing |
| M-06 | Orta | Asenkron quote çağrıları iptal edilmediği için eski sonuç yeni formu ezebilir | Kullanıcı niyeti/RPC DoS |
| M-07 | Orta | `creatorWallet` için sahiplik kanıtı yok; beneficiary “creator kimliği” olarak kullanılırsa taklit mümkün | Kimlik/ürün |
| M-08 | Orta | Limit üstü developer buy, reddedilmek yerine azami geçerli harcamaya dönüştürülüp gönderiliyor | Kullanıcı niyeti/fon harcama |
| L-01 | Düşük | v4 önizleme initialized tick geçişlerini modellemiyor | Quote doğruluğu |
| L-02 | Düşük | FeeHook claim, claimant ve hook bakiye deltalarını doğrulamıyor | Gelecek token uyumluluğu |
| L-03 | Düşük | Platform recipient hook'un kendisine ayarlanabilir ve ücretler erişilemez kalabilir | Yönetici hatası |
| L-04 | Düşük | Lock adresi state'te tutulmadığı için UI yalnız yakın event penceresini gösterebiliyor | Veri erişilebilirliği |
| L-05 | Düşük | “Launch dolabilir” sinyali executable liquidity yerine pool token custody kullanıyor | Yanlış güven sinyali |

---

## 5. Yüksek önem bulguları

### H-01 — Kalıcı asset eşikleri çözümlenmemiş ve test edilen eşiklerle uyuşmuyor

**Etkilenen yerler**

- `script/DeployCurb.s.sol:103-153`
- `script/DeployCurb.s.sol:168-217`
- `test/fork/B20MultiAsset.t.sol:117-173`
- `test/fork/B20MultiAsset.t.sol:508-514`

**Kanıt**

Deploy script'i eşikleri yaklaşık 13.231 USD hedefinden türettiğini söylüyor, ancak
aynı dosya hızlı yeniden türetmenin aynı blokta yedi varlığın beşinde 3–4 kat
ayrıştığını ve sebebin çözülmediğini açıkça kaydediyor. Eşik ve phantom factory
başına kalıcıdır; curve fiyat ölçeğini, graduation'a gereken quote miktarını ve
mezun havuzun açılış derinliğini birlikte belirler.

Lifecycle testinin yorumu değerlerin DeployCurb önerileri olduğunu söylüyor; gerçek
değerler şöyledir:

| Varlık | Deploy eşiği | Test eşiği | Aynı mı? |
|---|---:|---:|---:|
| WETH | 4,8 | 4,8 | Evet |
| SPCXc | 88 | 44 | Hayır |
| GOOGLc | 39 | 48 | Hayır |
| AMZNc | 52 | 12,8 | Hayır |
| MSFTc | 26 | 5,6 | Hayır |
| AAPLc | 40 | 3,4 | Hayır |
| METAc | 20 | 2,5 | Hayır |

Deploy listesinde ayrıca cbBTC, cbXRP, cbZEC ve NVDAc vardır; güncel
`B20MultiAsset` lifecycle listesi bunları çalıştırmıyor. Sonuç olarak 11 deploy
varlığından yalnız WETH aynı kalıcı eşikle uçtan uca sınanmıştır.

Coinbase'in resmi wrapped-asset sayfası cbBTC ve cbXRP adreslerini deploy script'iyle
aynı veriyor; yani burada bulgu adreslerin yanlış olduğu değil, **bu adreslere ait
kalıcı ekonomik ölçeğin ve lifecycle'ın doğrulanmadığıdır**:
<https://www.coinbase.com/campaigns/wrapped-assets>

**Etki**

- Yanlış eşik curve'ü amaçlanandan çok pahalı veya ucuz açabilir.
- Graduation için gereken quote miktarı ve yeni v4 havuzunun derinliği kalıcı olarak
  yanlış ölçeklenebilir.
- Test paketi yeşil olduğu halde gerçek deploy parametresi denenmemiş olabilir.
- Özellikle ince piyasalarda eşik ile mevcut likidite arasındaki hata launch'ın uzun
  süre graduate olamamasına veya çok sığ bir pool açmasına yol açar.

**Öneri**

Her 11 asset için tek bir makine-okunur parametre kaynağı kullanılmalı; deploy ve
test aynı tabloyu tüketmelidir. Ölçüm aracı, blok numarası/hash'i, fiyat kaynağı,
decimals, multiplier ve route ile yeniden üretilebilir olmalıdır. Çözümlenmemiş
3–4x ayrışma kapanmadan bu factory'ler mainnet'e dağıtılmamalıdır.

### H-02 — Oracle/reference-deviation ve hafta sonu modu bilinçli olarak yok

**Etkilenen yerler**

- `test/fork/B20PriceFeed.t.sol:32-54`
- `PRE_MAINNET.txt:592-688`
- curve ve pool trade yollarının tamamı

Kod yalnız curve/pool'un kendi spot durumuna ve kullanıcının minimum output'una
dayanır. `minOut`, işlem hazırlanırken görülen DEX fiyatına göre kaymayı sınırlar;
başlangıç fiyatının gerçek-world asset referansından zaten kopmuş olmasını önlemez.

Bu risk projede gizli değildir: `B20PriceFeed.t.sol` ve `PRE_MAINNET` oracle,
reference-deviation guard, staleness ve weekend state bulunmadığını karar olarak
yazıyor. Audit açısından bunun anlamı, bir korumanın yanlış uygulanması değil,
yüksek etkili ekonomik saldırı/yanlış fiyat riskinin kabul edilmiş olmasıdır.

Base'in güncel resmi B20 entegrasyon rehberi, equity feed'lerinin 24/5 çalıştığını,
gece/hafta sonu/tatilde son değeri tuttuğunu ve `updatedAt` okunmadan frozen feed'e
dayanılmaması gerektiğini açıkça söyler. Ayrıca fiyatın underlying × multiplier
olduğunu belirtir:
<https://docs.base.org/build-on-base/integrate-defi/list-tokenized-stocks>

**Etki**

- İnce DEX fiyatı manipüle edilmişken işlemin kendi slippage kontrolü yine geçebilir.
- ETH/USDC route doğru çalışan bir AMM kotası döndürür fakat RWA ekonomik referansından
  büyük sapma taşıyabilir.
- Hafta sonu/tatil/corporate-action anında kullanılacak referans davranışı tanımsızdır.
- Kalıcı asset eşiklerinin USD karşılığı zamanla kayar; hiçbir on-chain adaptasyon yoktur.

**Öneri**

Bu karar korunacaksa uygulama bunu “RWA referansına bağlı fiyat” gibi sunmamalı ve
mainnet risk kabulü açıkça imzalanmalıdır. Koruma eklenecekse equity ile coin quote
asset'ler ayrı adapter/liveness kurallarına sahip olmalı; frozen feed karşısında
router geniş toleransla çalıştırılmamalıdır.

### H-03 — Issuer policy ve pause, protokolün liveness'ını dışarıdan durdurabilir

**Etkilenen yerler**

- `src/curb/Graduator.sol:217-253`
- `src/vendor/PonsV2BondingCurve.sol:749-790`
- `src/curb/FeeHook.sol:636-700`
- B20 quote asset kullanan curve/pool'lar

Yeni fee-debt tasarımı önemli iki eski açığı kapatıyor: blocked creator artık normal
pool swap'ini düşürmüyor ve WETH recipient callback'i PoolManager kilidi içinde
çalışmıyor. Fakat issuer seviyesindeki transfer yetkisi ortadan kalkmıyor.

`rescueCurveFees()` yalnız escrow adresinin transfer alamadığı özel yolu bypass eder.
Kodun kendi yorumu, protocol recipient engelliyse doğrudan rescue'nun da revert
edeceğini söylüyor. Global transfer pause, curve/Graduator/hook'un kendisinin
engellenmesi veya gerekli sender/receiver policy değişikliği halinde:

- fee sweep ve graduation durabilir;
- hazır curve'de alım ve satım kapalı kaldığı için launch beklemede kilitlenebilir;
- hook borcu kaydedilmiş olsa bile daha sonra claim edilemeyebilir;
- PoolManager/Graduator arasındaki zorunlu token hareketi başarısız olabilir.

Base'in resmi dokümanı `approve()` sonucunun transfer izni anlamına gelmediğini,
policy'nin transferi reddedebildiğini, fonksiyonların pause edilebildiğini ve issuer
admin işlemlerinde standardın kendi zorunlu timelock'u olmadığını söylüyor:
<https://docs.base.org/build-on-base/integrate-defi/list-tokenized-stocks>

**Etki**

Bu, Curb sahibinin veya permissionless kullanıcının düzeltebileceği bir durum değildir.
Quote asset issuer'ı tek bir politika değişikliğiyle launch liveness'ını etkileyebilir.
Fonlar çalınmaz; fakat trade, graduation veya claim süresiz durabilir.

**Öneri**

Her quote asset için hangi protokol adreslerinin hangi sender/receiver policy'lerine
tabi olduğu dağıtım öncesi ölçülmeli ve izlenmelidir. UI policy/pause durumunu işlemden
önce göstermeli. Rescue'un yalnız escrow blokajını çözdüğü, issuer/global pause için
garanti vermediği runbook'ta launch engeli olarak kalmalıdır.

---

## 6. Orta önem bulguları

### M-01 — Canlı platform payı ile sabit %0,5 açıklaması çelişiyor

**Etkilenen yerler**

- `src/curb/FeeHook.sol:155-176`, `:317-418`
- `web/app.js:2095-2097`, `:3246-3254`
- `src/curb/CurbLaunchFactory.sol:80`, `:146-148`
- `FEE_POLICY.txt:8-13`, `:97-100`
- `PRE_MAINNET.txt:62-64`, `:108-114`, `:1321-1323`

Güncel hook'ta `platformRecipient` ve `platformFeeBps` immutable değildir. Owner,
24 saatlik duyuru ve 7 günlük yürütme penceresiyle recipient'ı değiştirebilir;
platform payını 0–80 bps aralığına taşıyabilir. Değişiklik mevcut bütün mezun
pool'lara canlı uygulanır. Curve tarafı launch anındaki snapshot'ı korur.

Arayüz hesaplamada canlı `platformFeeBps()` okuduğu için sayısal tutar doğrudur;
ancak confirmation ve başarı mesajı hâlâ “fixed 0.5%” der. Kontrat başlığı, factory
yorumları, deploy/preflight ve FEE_POLICY/PRE_MAINNET'in bazı erken bölümleri de
recipient/rate'in immutable veya sabit olduğunu söyler. Aynı PRE_MAINNET dosyasının
D2 bölümü daha sonra gerçeği doğru anlatır; dosya kendi içinde çelişir.

**Etki**

- Kullanıcıya ekonomik sözleşme yanlış açıklanır.
- %1 tax launch'ta creator payı 50 bps'ten 20 bps'e düşebilir; trader'ın toplam tax'ı
  aynı kalırken gelir dağılımı önemli ölçüde değişir.
- Operatör eski “immutable Safe” gerekçesiyle yanlış deploy kararı verebilir.

**Öneri**

Tek bir fee-policy açıklaması kullanılmalı. UI metni canlı bps'i yazmalı; “sabit”
kelimesi kaldırılmalı. Curve snapshot / pool live ayrımı bütün runbook ve audit
kayıtlarında aynı şekilde anlatılmalıdır.

### M-02 — Safe doğrulaması closure kriterini zorlamıyor

**Etkilenen yerler**

- `script/DeployCurb.s.sol:255-325`
- `script/b20/preflight-mainnet.sh:69-92`
- `PRE_MAINNET.txt:506-583`

Deploy script'i EOA recipient'ı varsayılan olarak reddediyor; bu iyi bir korumadır.
Ancak kodu olan herhangi bir adres devam edebilir. `getOwners()` ve `getThreshold()`
çağrıları yalnız log basar; beklenen owner listesi, eşik, Safe singleton/proxy kimliği,
enabled module veya guard durumu assert edilmez. Çağrılara cevap vermeyen kontrat da
yalnız WARNING ile kabul edilir.

Policy owner doğrudan DeployCurb çalıştırıldığında `CURB_POLICY_OWNER` yoksa deployer'a
düşer. Preflight ortam değişkenini zorunlu tutsa da deploy script'i kendi başına bu
korumayı taşımaz.

Safe'in resmi dokümanı güvenlik kararının sadece “kontrat kodu var” olmadığını;
owner listesi, threshold ve imzaları bypass edebilen module'ların yetki modelinin
parçası olduğunu açıklar:
<https://docs.safe.global/advanced/smart-account-concepts>

**Etki**

Yanlış Safe, 1/1 Safe, beklenmeyen owner seti veya imza eşiğini bypass eden module
mainnet deploy'da kabul edilebilir. Revenue recipient ve policy owner protokolün
ekonomik kontrol yüzeyidir.

**Öneri**

Mainnet modu beklenen chain ID, Safe adresi, exact owner seti, threshold, singleton
ve izin verilen module/guard politikasını fail-closed doğrulamalıdır. Test override'ı
yerel fork ile sınırlı kalmalıdır.

### M-03 — Registry deployer kalıcı launcher admission yöneticisidir

**Etkilenen yerler**

- `src/curb/LaunchRegistry.sol:168-181`
- `src/curb/LaunchRegistry.sol:256-303`
- `src/curb/LaunchRegistry.sol:306-327`

Immutable `deployer`, `addLauncher()` ile süresiz yeni launcher ekleyebilir. Timelock,
renounce, owner transfer, launcher removal veya launcher cap yoktur. Eklenen launcher
kalıcıdır.

`_checkLoopCloses()` launcher'ın o anda aynı registry/graduator/hook/PoolManager
döngüsüne baktığını doğrular. Launcher bytecode'unun canonical factory olduğunu,
ekonomik terimleri koruduğunu veya `graduator()` getter'ının daha sonra değişmeyeceğini
kanıtlamaz. Kabul edilen launcher registry'nin canonical discovery listesine kayıt
yazabilir.

**Etki**

- Deployer key compromise canonical listeye kötü niyetli/spam factory ekleyebilir.
- UI registry'den launcher/quote listesi okuduğu için eklenen factory'yi kullanıcıya
  resmi seçenek gibi sunabilir.
- Deployer key kaybı yeni asset factory eklemeyi sonsuza dek durdurur.

**Öneri**

Bu rol dağıtım anahtarı değil governance rolü olarak ele alınmalı: doğrulanmış Safe,
duyuru/gecikme, exact factory codehash/immutable kontrolü ve planlı sonlandırma gerekir.

### M-04 — Hosted UI canonical deployment kimliğini doğrulamıyor

**Etkilenen yerler**

- `web/app.js:250-270`
- `web/app.js:316-379`

RPC, factory, lens ve token URL query veya `localStorage` üzerinden alınır. Action
başlarken wallet chain ile RPC chain eşleşmesi, factory→registry→hook döngüsü ve token
kaydı tekrar okunur; bu yarışlara karşı iyi bir savunmadır. Fakat aynı chain üzerinde
adreslerin **CURB'un resmi deployment'ı** olduğu doğrulanmaz.

Arayüz custom deployment explorer olarak tasarlanıyorsa davranış meşrudur. Aynı sayfa
production kullanıcı fonu yönetecekse saldırgan aynı arayüzü, aynı Base chain ID'sini
ve interface-shape kontratlarını içeren linkle açtırabilir. Kullanıcı Permit2/token
approval ve trade işlemlerini saldırgan deployment'a verir.

**Öneri**

Production modu chain ID'ye bağlı imzalı/commit edilmiş address book ve kritik runtime
codehash'leri fail-closed doğrulamalı; custom deployment modu belirgin ve ayrı olmalıdır.

### M-05 — USDC iki-hop routing yalnız bir tier kombinasyonunu kotaya sokuyor

**Etkilenen yerler**

- `web/app.js:1750-1792`
- `web/app.js:1803-1840`

Doğrudan WETH→quote için bütün v3 tier'ları QuoterV2'ye gider. WETH→USDC→quote
rotasında ise custody sırasındaki yalnız `[0] × [0]` kombinasyonu adaydır. Kaynak
yorumunun bir bölümü top-two/four-path tasarımını anlatırken hemen altındaki çalışan
kod “ONE TWO-HOP CANDIDATE” uygular.

Concentrated-liquidity AMM'de kontratın tuttuğu toplam token, gerçek boyutta alınan
çıktıyı belirlemez. Başka bir tier kombinasyonu daha fazla output verebilir veya tek
çalışan yol olabilir. Discovery çağrısı geçici hata verirse fallback yalnız doğrudan
WETH tier'larını döndürür ve USDC route tamamen kaybolur.

**Etki**

Kullanıcı mevcut daha iyi rotaya rağmen daha az çıktı alabilir veya USDC ile erişilebilir
asset için “quote edilemiyor” görebilir. `minOut` seçilen kötü rotayı güvenli yapar,
optimal yapmaz.

**Öneri**

Ölçülmüş bir çağrı bütçesi içinde en az top-N kombinasyonlar gerçek tutarla paralel
quote edilmelidir. Fallback son başarılı candidate setini kullanabilir; sessizce başka
bir route ailesine daralmamalıdır.

### M-06 — Eski asenkron quote yeni form durumunu ezebilir

**Etkilenen yerler**

- `web/app.js:1803-1840`
- `web/app.js:2043-2115`
- `web/app.js:3383-3385`

Her input event'i yeni `renderPoolQuote()` başlatır. Generation counter,
`AbortController`, debounce veya “bu sonuç hâlâ son input'a mı ait?” kontrolü yoktur.
Quoter çağrıları `Promise.race` ile dört saniyede bırakılır; alttaki RPC isteği iptal
edilmez. Önceki yavaş render, sonraki hızlı render'dan sonra tamamlanıp DOM'u eski
miktar/side/via sonucu ile yeniden yazabilir.

Transaction yolu `poolActionInner()` içinde kotayı yeniden hesapladığı için stale DOM
doğrudan stale calldata üretmez; minOut güncel hesaplanır. Risk kullanıcının ekranda
gördüğü şartlarla wallet'a giden şartların ayrışması ve terk edilmiş çağrıların RPC'yi
yormasıdır.

**Öneri**

Her render'a artan kimlik verilmeli; yalnız en son kimlik DOM yazabilmelidir. Input
debounce edilmeli ve mümkün olan transportlarda eski istek iptal edilmelidir.

### M-07 — `creatorWallet` sahipliği doğrulanmıyor

**Etkilenen yerler**

- `src/curb/CurbLaunchFactory.sol:126-182`
- `src/curb/CurbLaunchFactory.sol:509-529`
- `web/app.js:2323-2340`, `:2469`, `:2547-2562`
- `PRE_MAINNET.txt:432-459` ve kontratın eski üst-seviye yorumları

`creatorWallet` sıfır değilse caller yerine curve fee recipient, hook creator ve LP
lock beneficiary olur. O adresin imzası veya EIP-1271 onayı istenmez. Bu, hot wallet'tan
cold wallet'a gelir yönlendirme özelliği olarak kasıtlıdır; fon çalma değildir.

Fakat permissionless herhangi biri herhangi bir adresi “creator wallet” olarak yazabilir.
Kontratın ve PRE_MAINNET'in bazı bölümleri hâlâ “caller creator olur” ve “creator
`msg.sender`, field değil” der. Discovery veya ilerideki UI beneficiary'yi kimlik/proje
sahipliği olarak gösterirse üçüncü taraf bir cüzdan adına sahte launch üretilebilir.

**Etki**

- On-chain beneficiary, launch'ı kimin başlattığını kanıtlamaz.
- Yanlış girilmiş veya kontrol edilmeyen immutable wallet fee ve LP pozisyonunu kalıcı
  olarak erişilemez yapabilir.

**Öneri**

Beneficiary yalnız ödeme adresi olarak adlandırılmalı. “Verified creator” gösterilecekse
creator wallet'ın launch parametrelerini imzaladığı ayrı EIP-712/EIP-1271 kanıtı gerekir.

### M-08 — Limit üstü developer buy geçerli azami harcamaya dönüştürülüyor

**Etkilenen yerler**

- `web/app.js:2362-2383`
- `web/app.js:3384-3400`
- `web/e2e/app.spec.js:2934-2953`
- `web/e2e/app.spec.js:3090-3126`

Audit kapanışı sırasında çalışma ağacına eklenen `capField()`, kullanıcı developer buy
alanına izin verilen değerin üstünde bir tutar yazdığında değeri doğrudan tavana çevirir.
60 quote birimlik fixture'da `999` yazılması alanı `45` yapar. `launch()` yolundaki
bağımsız kontrat/factory tavanı korunuyor; sorun, geçersiz kullanıcı niyetinin reddedilmek
yerine azami geçerli işleme çevrilmesidir.

Bu davranış yalnız teorik olarak çıkarılmadı. Güncel Playwright paketi şu eski güvenlik
iddiasında düştü:

```text
the form refuses a dev buy above three quarters of the threshold, and says the figure
Error: a dev buy above the ceiling was accepted
Expected: not "sent"
```

Koşu sonucu **61 geçti, 1 düştü, 3 çalışmadı**. Aynı çalışma ağacına eklenen yeni test,
alanın `999` değerini `45` olarak tuttuğunu bekliyor; serial pakette önceki test düştüğü
için bu yeni test çalışmadı. Böylece test paketi aynı davranış hakkında birbiriyle
çelişen iki ürün iddiası taşıyor.

**Etki**

Bir yazım hatası veya farklı birim varsayımı, açık bir ret yerine kullanıcının izin
verebileceği en yüksek developer buy'ı hazırlar. Sayfa “Held at 45” notunu gösterse de
finansal işlem niyeti korunmaz; kullanıcı kendi yazdığı miktardan farklı, büyük ve geçerli
bir transferi cüzdanda onaylayabilir. Tax alanı da aynı yardımcıyla değiştirilir; tax
kalıcı launch parametresi olduğundan orada da otomatik yeniden yazma açık onay yerine
geçmemelidir.

**Öneri**

Alan kullanıcı girdisini korumalı, limit üstünde açık hata göstermeli ve gönderim düğmesini
devre dışı bırakmalıdır. İşlem yolundaki factory/chain-read limit kontrolü kalmalıdır.
Testler tek ürün kuralında birleşmeli: limit üstü değer hiçbir transaction üretmemelidir.

---

## 7. Düşük önem bulguları

### L-01 — v4 preview tick crossing'i modellemiyor

`web/app.js:950-995` yalnız mevcut `sqrtPriceX96` ve active liquidity ile tek-range
formülü uygular. Graduation pozisyonu full-range olsa da üçüncü taraflar concentrated
liquidity ekleyebilir; hook'un add/remove-liquidity permission bitleri yoktur. Swap yeni
initialized tick geçince active liquidity değişir ve yerel formül kesinliğini kaybeder.

Uniswap'ın resmi `Hooks.sol` kaynağı callback çağrılarının hook adresindeki permission
bitleriyle belirlendiğini doğrular:
<https://github.com/Uniswap/v4-core/blob/main/src/libraries/Hooks.sol>

Kötü quote çoğunlukla minOut nedeniyle revert/gas kaybı üretir; doğrudan fon kaybı
kanıtlanmadığı için düşük sınıflandırılmıştır. Gerçek v4 quoter/simulation tercih edilir.

### L-02 — FeeHook claim generic/non-standard tokenı kısa ödeyebilir

`FeeHook.claim()` borcu sıfırlar ve `SafeERC20.safeTransfer` yapar, fakat claimant'ın
aldığını ve hook bakiyesinden çıkan miktarı ölçmez (`FeeHook.sol:677-700`). Aynı repo
içindeki `FeeEscrow._claim()` tam bu iki deltayı ölçer (`FeeEscrow.sol:271-280`).

Planlı WETH/B20 varlıklarında fee-on-transfer davranışı ölçülmedi ve beklenmiyor. Fakat
factory yüzeyi decimals yanıtlayan generic token kabul edecek şekilde genişletilirse,
short-pay token alacağı silebilir veya pooled debt backing'inden fazla çekebilir.

### L-03 — Platform recipient hook'un kendisi yapılabilir

`announcePlatformRecipient()` yalnız sıfır adresi reddeder. `address(hook)` seçilirse
non-WETH doğrudan `PoolManager.take(..., hook, amount)` başarılı sayılır ve `owed`
yazılmaz; token hook'ta sahipsiz kalır. WETH'te `owed[hook][WETH]` oluşur fakat hook
kendi adına `claim()` çağrısı başlatamaz. Bu owner hatasıdır, trader fonu değil platform
geliri etkilenir.

### L-04 — Eski graduation lock bilgisi UI'da bulunamıyor

Graduator lock adresini event olarak yayımlar fakat state getter'ında saklamaz.
`web/app.js:2117-2163`, endpoint'in kabul ettiği son yaklaşık 1.000 blok içinde log
arar. Daha eski launch'ta UI lock adresi, beneficiary, unlock ve position bilgisini
gösteremez. Fon zincirde güvendedir; keşif/operasyon görünürlüğü kaybolur.

### L-05 — Thin-market sinyali custody'yi liquidity gibi kullanıyor

`web/app.js:1270-1319`, WETH ve USDC çiftlerinde pool kontratının tuttuğu quote token
bakiyesini karşılaştırır. Bu değer:

- aktif tick çevresindeki executable liquidity değildir;
- fiyat etkisini göstermez;
- diğer venue'leri ve iki pool'un birlikte kullanılmasını içermez;
- pool'da token bulunmasının bir trade ile threshold kadar alınabileceğini kanıtlamaz.

Uyarının “market holds X” kelimesi doğrudur; fonksiyon başlığındaki “can fill” ve
`enough` sonucu daha güçlüdür. Bu sinyal kesin kapasite olarak sunulmamalıdır.

---

## 8. Bilgi ve mainnet hazırlık notları

### I-01 — Stale yorumlar güvenlik modelini yanlış anlatıyor

- FeeHook başlığı platform payını sabit 50 bps anlatıyor; çalışan kod canlı 0–80 bps.
- Deploy/preflight yorumları hook recipient'ını immutable anlatıyor; çalışan kod rotasyonlu.
- Factory üst yorumu creator'ın daima `msg.sender` olduğunu söylüyor; `creatorWallet`
  bunu değiştirebiliyor.
- `web/app.js` içindeki kullanılmayan `CANDIDATE` 3000/60 değerlerini taşıyor; gerçek
  deploy 500/10. Runtime etkisi yok, bakım riski var.
- FeeHook `_pay` çevresindeki bazı yorumlar “paid out now / WETH leaves as ETH” derken
  güncel `_deliver` WETH'i borç olarak tutuyor.

### I-02 — Factory bytecode marjı izlenmeli

Factory runtime 21.215 byte ve EIP-170 altında 3.361 byte marj bırakıyor. Şu an deploy
edilebilir; yeni asset/policy mantığını factory içine eklerken boyut gate'i CI'da kalmalı.

### I-03 — Bağımsız dış audit ve lisans kapanmadı

Repo içi yoğun test ve bu audit üçüncü taraf denetimin yerine geçmez. PRE_MAINNET'in
external review, v4-core BUSL/hukuki pozisyon, gerçek adres defteri, explorer source
verification ve venue allowlist maddeleri mainnet öncesi açık kalmalıdır.

### I-04 — Statik analiz sınırı

`forge lint` çalıştırıldı; fatal bulgu vermedi. Görülen unsafe cast uyarıları özellikle
FeeHook ve Graduator'da manuel olarak çağrı öncesi sınırlarla karşılaştırıldı. Slither
bu sistemde kurulu değildi; rapor Slither sonucu iddia etmez.

---

## 9. Önceki audit bulgularının yeniden kontrolü

| Eski bulgu | Güncel durum | Kanıt |
|---|---|---|
| WETH recipient PoolManager reentrancy ile swap DoS | **Kapalı** | WETH callback içinde gönderilmiyor; hook borç yazıyor, claim unlock dışında ve reentrancy guard altında |
| B20 blocked creator recipient bütün swap'i düşürüyor | **Kapalı** | Doğrudan `take` başarısızsa hook kendine alıp `owed` yazıyor |
| Dev buy stale global decimals/threshold ile okunuyor | **Kapalı** | create action pinned factory decimals/threshold ve chain-read cap kullanıyor |
| Başarılı WETH swap receipt'i yanlış reconciliation | **Kapalı** | reconciliation hook debt/direct payout biçimlerini ayırıyor |
| Launch fee recipient reddederse herkes launch edemiyor | **Kapalı** | fee borç yazılıyor; `withdrawLaunchFees()` pull-payment yolu var |
| UI dev-buy cap ikinci sabit | **Kapalı** | `maxDevBuyBps()` factory'den okunuyor |
| Açıklama sessiz kesiliyor | **Kapalı** | gönderim yolunda uzunluk reddediliyor |
| Lens caller'ın istediği sınırsız page okuyor | **Kapalı** | page cap'i uygulanıyor |

Kapanmış bulguların yeniden açık yazılması bu raporun kapsamına aykırı olurdu. Güncel
H-03, eski “blocked creator swap DoS” bulgusunun geri gelişi değildir: normal swap'in
recipient teslimatından ayrılması başarılıdır; kalan risk issuer'ın protokol adreslerini
veya transfer fonksiyonunu bütünüyle durdurabilmesidir.

## 10. Önerilen kapanış sırası

1. **H-01:** 11 asset için tek parametre kaynağı, tekrar üretilebilir ölçüm ve deploy
   değerleriyle birebir lifecycle testleri.
2. **M-02 / M-03:** recipient, policy owner ve registry deployer rollerinin gerçek Safe
   sahip/eşik/module doğrulaması; governance kararının kaydı.
3. **M-01:** canlı fee policy'nin UI, kontrat yorumları ve runbook boyunca tek anlatımı.
4. **H-03:** her asset için policy/pause liveness matrisi ve mainnet monitoring/runbook.
5. **M-04:** production canonical deployment/address-book doğrulaması.
6. **M-05 / M-06 / M-08 / L-01:** routing, quote determinismi ve limit üstü kullanıcı
   girdisinin transaction'a dönüştürülmemesi.
7. **H-02:** kabul edilmiş risk olarak imzalı karar veya oracle/weekend tasarımı; ikincisi
   seçilirse kontrat kapsamı değişeceği için external audit bundan sonra yapılmalı.
8. Kalan düşük bulgular, dış audit ve mainnet explorer doğrulaması.

## 11. Nihai değerlendirme

Kodun muhasebe ve atomicity savunmaları önceki sürüme göre belirgin biçimde güçlüdür.
Fee delivery'nin swap'ten ayrılması, graduator'ın balance-delta kontrolleri, registry'nin
hook permission doğrulaması, pull-payment yolları ve testlerdeki mutation/fault-injection
disiplini olumlu bulgulardır. Kontrat tarafındaki 335 bağımsız testin yeşil olması
anlamlıdır. Ancak audit kapanışındaki güncel browser çalışma ağacı yeşil değildir:
61 test geçti, 1 test düştü ve serial akışta 3 test çalışmadı.

Buna rağmen **mainnet için “hazır” sonucu verilemez**. Bunun temel nedeni yeni bir
permissionless drain değil; kalıcı ekonomik parametrelerin ölçüm/test kökeninin
çözümlenmemiş olması, resmi RWA fiyat/liveness bağımlılıklarının korumasız kabulü ve
yüksek yetkili rollerin gerçek Safe/canonical deployment kontrollerinin tamamlanmamasıdır.

Bu rapor bir düzeltme commit'i değildir. Ürün kaynaklarına hiçbir yama uygulanmadı.
