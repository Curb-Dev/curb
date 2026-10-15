# CURB yeniden denetim raporu — 23 Eylül 2026

## 1. Sonuç

Bu denetim mevcut çalışma ağacını güvenlik, muhasebe, entegrasyon ve kullanıcı işlemi bütünlüğü açısından yeniden inceledi. **Hiçbir ürün kodu düzeltilmedi.** Bu dosya yalnızca bulguları, kanıtları ve önerilen çözüm yönlerini kaydeder.

Sonuç: **3 yüksek, 6 orta, 4 düşük önem bulgusu** ve mainnet öncesi ayrıca kapatılması gereken 5 tasarım/operasyon riski bulundu.

En kritik üç konu:

1. WETH çiftinde creator’ın seçtiği ücret alıcısı, ETH kabul ederken PoolManager’a yeniden girip havuzun bütün normal swap’lerini `CurrencyNotSettled()` ile durdurabiliyor.
2. B20 quote asset’in ihraççısı, değiştirilemeyen creator ücret adresini alıcı politikasında engellerse mezun olmuş RWA havuzunun normal swap’leri ücret ödemesi sırasında geri dönüyor. Havuz tarafı curve’de kullanılan escrow ayrıştırmasını kaybediyor.
3. Create formu, dev buy miktarını işlemin sabitlediği factory yerine global render önbelleğinin decimal/threshold değerleriyle ölçekliyor. Factory değişimi veya eksik önbellek halinde kullanıcı yazdığından 100 kat fazla 6-decimal RWA harcayabilir.

Bu sonuç “audit tamamlandı, sistem güvenlidir” anlamına gelmez. Kod eşzamanlı değiştiriliyordu; rapor aşağıdaki hash’lerle tanımlanan anlık görüntüyü denetler.

## 2. Kapsam ve sabitlenen anlık görüntü

- Git HEAD: `774485c98b5ea454cea1a8cb6c91978098261808`
- Dal: `master`
- Denetim sırasında çalışma ağacı temiz değildi. Claude tarafından `web/app.js`, `test/fork/B20Graduation.t.sol`, `web/e2e/app.spec.js`, `script/b20/demo-app.sh`, audit kaydı ve derleme çıktıları değiştiriliyordu.
- Denetlenen kritik dosya hash’leri:
  - `src/curb/FeeHook.sol`: `69186DE03A726AA993FA782F03B377DFA2995EC1F19AE6E6E5F0071AB373263E`
  - `web/app.js`: `6E40AD5CAB69E0B985B92B25708AB2A5578DA0476F92BD76C9B0FBE227FFBC80`
  - `script/DeployCurb.s.sol`: `156C5FC9FE99F79B0FA5783BFE83BE1B11A0F59BC90388E227F509D5D35293F9`

İncelenen ana yüzeyler:

- `src/curb/`: factory, hook, registry, graduator, fee escrow, fee policy, position lock, launch token, lens
- vendored PONS curve ve Uniswap v4 PoolManager etkileşimi
- deploy ve preflight betikleri
- browser app’in create, quote, route, receipt ve reconciliation yolları
- non-fork testler, seçilmiş gerçek Base fork testleri, lint ve bytecode boyutları

Hariç kalanlar:

- Harici ekonomik denetim, oracle doğruluğu ve piyasa manipülasyon simülasyonu
- BUSL/hukuki görüş
- Mainnet üzerinde deploy doğrulaması
- Tam browser ve tam fork paketinin bu anlık görüntüde tekrar çalıştırılması; eşzamanlı düzenlemeler nedeniyle yalnız kritik hedef testler bağımsız tekrarlandı

## 3. Önem özeti

| Kimlik | Önem | Başlık | Güven |
|---|---|---|---|
| H-01 | Yüksek | WETH creator alıcısı PoolManager’a yeniden girerek mezun havuzu durdurabiliyor | Kesin; fork testiyle yeniden üretildi |
| H-02 | Yüksek | B20 alıcı politikası, immutable creator ücret adresi üzerinden mezun RWA havuzunu kilitleyebiliyor | Kesin mekanizma; gerçek B20 politika testleri geçti |
| H-03 | Yüksek | Dev buy, sabitlenmiş factory yerine eski/eksik UI context’iyle ölçekleniyor | Kesin statik akış |
| M-01 | Orta | Başarılı doğrudan WETH havuz işlemleri receipt uzlaştırmasında yanlışlıkla başarısız görünüyor | Kesin statik akış |
| M-02 | Orta | v4 önizlemesi initialized tick geçişlerini modellemiyor | Kesin tasarım sınırı |
| M-03 | Orta | v3 rota adayları kotadan önce custody ile eleniyor | Kesin statik akış |
| M-04 | Orta | Registry deployer süresiz ve gecikmesiz canonical launcher ekleyebiliyor | Kesin yetki modeli |
| M-05 | Orta | Launch fee, korumasız harici çağrı ile platform alıcısına gönderiliyor | Kesin statik akış; güvenilir rol önkoşulu |
| M-06 | Orta | Hosted uygulama RPC/factory/lens kimliğini URL/localStorage’dan alıp canonical deploy doğrulamıyor | Kesin; production davranışı koşullu |
| L-01 | Düşük | “Launch dolabilir” uyarısı aktif likidite yerine pool token bakiyesini kullanıyor | Kesin ölçüm sınırı |
| L-02 | Düşük | Dev-buy tavanı UI’da ikinci bir sabit olarak tutuluyor | Kesin drift riski |
| L-03 | Düşük | Açıklama sessizce 300 karaktere kesiliyor | Kesin UX/veri bütünlüğü |
| L-04 | Düşük | Public lens sayfası caller’ın istediği kadar zincir okuması yapıyor | Kesin RPC DoS yüzeyi |

---

## 4. Yüksek önem bulguları

### H-01 — Creator’ın WETH ücret alıcısı mezun havuzu yeniden girişle durdurabilir

**Etkilenen kod**

- `src/curb/FeeHook.sol:112-127`
- `src/curb/FeeHook.sol:608-618`
- `src/curb/FeeHook.sol:630-643`
- `lib/v4-core/src/PoolManager.sol:104-113`
- `lib/v4-core/src/PoolManager.sol:291-296`

**Kök neden**

WETH çiftinde hook önce birleşik ücreti PoolManager’dan kendine alıyor, WETH’i ETH’ye çeviriyor ve platform ile creator’a ayrı ayrı `_payNative` çağrısı yapıyor. `_payNative`, alıcıya 30.000 gas ile `call` yapıyor. Kod yorumunda bu miktarın PoolManager’a “yararlı” yeniden giriş için yetmeyeceği ve alıcının locker olmadığı için Manager’ın zaten reddedeceği iddia ediliyor.

Bu iki varsayımdan ikincisi kaynak kodda yanlış: `PoolManager.take()` yalnız `onlyWhenUnlocked` kontrolü taşıyor; caller’ın unlock başlatan adres olmasını istemiyor. Çağrı deltayı `msg.sender` adına kaydediyor. Creator’ın `receive()` fonksiyonu bir wei `take()` yapıp bu borcu kapatmadan normal dönerse hook `sent == true` görür ve WETH fallback’ine geçmez. Unlock sonundaki `NonzeroDeltaCount` kontrolü daha sonra tüm işlemi `CurrencyNotSettled()` ile geri alır.

**Saldırı akışı**

1. Creator, `creatorWallet` olarak saldırgan bir kontrat seçer.
2. Launch WETH karşısında mezun olur; creator adresi pool config’inde write-once olarak saklanır.
3. Normal bir swap creator ücret bacağını üretir.
4. Hook WETH’i ETH’ye çevirip creator’ın `receive()` fonksiyonunu 30.000 gas ile çağırır.
5. Creator `PoolManager.take(WETH, self, 1)` çağırır, hatayı kendi içinde yakalayıp normal döner.
6. Hook ödemeyi başarılı sayar; unlock sonunda kapanmamış delta bütün swap’i geri alır.
7. Aynı immutable creator alıcısı sonraki her normal swap’te aynı davranışı tekrarlar.

**Etki**

- Mezun pool efektif olarak işlem yapılamaz hale gelir.
- Holder çıkışı, alış ve fiyat keşfi durur.
- LP pozisyonu kilitli ve creator adresi pool için sabit olduğu için kullanıcının zincir üstünde kurtarma yolu yoktur.
- Çok küçük, ücret bacakları sıfıra yuvarlanan dust swap’ler bu çağrıya ulaşmayabilir; bu normal piyasa işlemlerini kurtarmaz.

**Kanıt**

`test/fork/B20Graduation.t.sol:260-281` içindeki `TakingReceiver` ve `:7491-7538` testi bu akışı kuruyor. Pinlenmiş Base forkunda bağımsız tekrar:

```text
[PASS] test_wethPool_aCreatorCanStopEverySwapByReenteringTheManager()
1 passed, 0 failed
```

Test yalnız revert beklemiyor; sarmalanmış revert verisinde `CurrencyNotSettled()` seçicisini arıyor.

**Resmî kaynak çapraz kontrolü**

- Uniswap v4 `IPoolManager.take` dokümantasyonu, çağrıyı caller’ın PoolManager’daki pozitif değerini çekme işlemi olarak tanımlar ve bunun flash-loan mekanizması olarak da kullanılabileceğini belirtir: <https://github.com/Uniswap/v4-core/blob/main/src/interfaces/IPoolManager.sol>
- Solidity güvenlik dokümanı, ETH aktarımının alıcı kontrata kontrol verdiğini ve çok-kontratlı yeniden girişin ayrıca değerlendirilmesi gerektiğini açıkça belirtir: <https://docs.soliditylang.org/en/latest/security-considerations.html#reentrancy>

**Önerilen çözüm yönü**

Swap callback’i içinde creator’a native ETH çağrısı yapılmamalı. Pull-payment/escrow muhasebesi, yalnız WETH ödeme veya swap bittikten sonra bağımsız claim yolu tercih edilmeli. Sabit gas miktarı güvenlik sınırı olarak kabul edilmemeli.

### H-02 — B20 receiver policy, immutable creator ücret adresi üzerinden mezun havuzu kilitleyebilir

**Etkilenen kod**

- `src/curb/FeeHook.sol:436-474`
- `src/curb/FeeHook.sol:630-643`
- `src/curb/CurbLaunchFactory.sol:166-182`
- `web/app.js:2337-2347`

**Kök neden**

WETH olmayan quote asset’lerde platform ve creator ücretleri, swap callback’i içinde doğrudan `poolManager.take(quote, recipient, amount)` ile gönderiliyor. B20 transferi receiver policy’den geçer. İhraççı creator adresini `TRANSFER_RECEIVER_POLICY` kapsamında engellerse `take()` geri döner ve atomiklik nedeniyle bütün swap geri alınır.

Creator alıcısı graduation sırasında registry kaydından hook’a yazılır ve değiştirilemez. UI yalnız adres biçimini kontrol eder; seçilen creator cüzdanının quote asset’i alıp alamadığını veya politikasının daha sonra değişebileceğini çözmez. Platform alıcısı gecikmeyle döndürülebilir; creator alıcısının rotasyonu yoktur.

**Başarısızlık akışı**

1. Launch bir B20 RWA quote asset’iyle mezun olur.
2. İhraççı veya paylaşılan policy yöneticisi creator cüzdanını receiver blocklist’e ekler ya da gerekli allowlist’ten çıkarır.
3. Normal swap, platform ve creator ücret bacaklarını hesaplar.
4. `poolManager.take()` creator’a B20 transferi yapmaya çalışır.
5. B20 precompile `PolicyForbids` ile geri döner; bütün swap geri alınır.

**Etki**

- Normal büyüklükteki alış ve satışlar durur; holder’lar mezun pool’dan çıkamaz.
- Politika değişikliği Curb’un kontrolünde olmayabilir.
- Aynı global B20 policy birden çok RWA’yı bağlıyorsa tek liste değişikliği birden fazla quote asset’i etkileyebilir.
- Curve tarafında fee escrow ile ayrıştırılan “alıcı teslim alamasa da trading/graduation devam etsin” özelliği pool tarafında yoktur.

**Kanıt**

Gerçek pinlenmiş Base forkunda mevcut iki test bağımsız tekrarlandı:

```text
[PASS] test_aBlockedRecipientIsRefusedWithPolicyForbids()
[PASS] test_oneBlocklistEntryStopsTwoDifferentAssets()
2 passed, 0 failed
```

İlk test receiver transferinin tam `PolicyForbids(TRANSFER_RECEIVER_POLICY, policy)` ile reddedildiğini; ikincisi tek registry kaydının iki B20 asset’i birlikte etkilediğini gösteriyor.

**Resmî kaynak çapraz kontrolü**

Base B20 dokümantasyonu, transfer sırasında token’ın global Policy Registry’ye receiver yetkisini sorduğunu ve yetkisiz receiver için `PolicyForbids` ile geri döndüğünü açıkça gösterir. Aynı liste birden fazla token tarafından paylaşılabilir: <https://github.com/base/base-std/blob/main/docs/overview.md#integrating-compliance-checks>

**Önerilen çözüm yönü**

Swap’in başarısı, değiştirilemeyen harici fee recipient’ın o anda B20 kabul edebilmesine bağlı olmamalı. Pool ücretleri de pull-payment/escrow muhasebesine ayrılmalı veya başarısız doğrudan ödeme hak sahibine borç olarak kaydedilmelidir. Creator alıcısı için politika uyumluluğu ön kontrolden geçirilse bile bu yalnız anlık durumu ölçer; issuer’ın gelecekteki değişikliği için ödeme mimarisi gerekir.

### H-03 — Dev buy yanlış factory context’iyle ölçeklenebilir ve yazılandan fazla RWA çekebilir

**Etkilenen kod**

- `web/app.js:300-363`
- `web/app.js:749-777`
- `web/app.js:2210-2227`
- `web/app.js:2350-2393`

**Kök neden**

`beginAction("create")` RPC, factory, quote token ve `quoteDecimals` değerlerini doğru biçimde işlem için sabitliyor. Ancak hemen sonra `createLaunch()` dev buy’ı sabitlenen `pin.quoteDecimals` ile değil, global render cache’i olan `ctx.quoteDecimals` ile okuyor:

```js
const devBuy = readDevBuy(ctx ? ctx.quoteDecimals : 8,
                          ctx ? ctx.threshold : 0n);
```

`ctx`, başka factory’ye ait olabilir; henüz yüklenmemişse 8 decimal ve sıfır threshold varsayılır. `pin` ayrıca threshold okumadığı için create işlemi gerçek factory’nin tavanını UI’da yeniden değerlendiremiyor.

**Somut senaryo**

- Önceki factory 8 decimal asset’e aittir veya `ctx` henüz yoktur.
- Kullanıcı 6 decimal bir B20 factory’sine geçer ve refresh bitmeden create’e basar.
- Formda dev buy olarak `1` yazılmıştır.
- UI `1 * 10^8` raw gönderir. 6 decimal asset’te bu **100 token**dır.
- Factory yalnız mutlak raw miktarın threshold’un %75’ini geçip geçmediğine bakar. Yanlış ölçekli 100 token cap’in altında kalıyorsa işlem geçer ve exact allowance üzerinden 100 token çeker.

Tersi yönde 18 decimal WETH benzeri asset’te `1`, yalnız `10^8 wei` olur; create başarılı olsa bile kullanıcının amaçladığı first buy gerçekleşmez.

**Etki**

- Kullanıcının yazdığından 100 kat fazla düzenlenmiş RWA harcanabilir.
- İşlem zincirde geçerli olduğu için wallet veya kontrat niyeti bilemez; geri alma yoktur.
- Factory’nin cap kontrolü bu hatayı yalnız yanlış miktar cap’i aşarsa yakalar.

**Önerilen çözüm yönü**

Create action’ın bütün sayısal girdileri aynı pinned factory context’inden okunmalı; decimal, threshold ve dev-buy tavanı `pin` üzerinde aynı RPC/factory snapshot’ından gelmelidir. Global render state işlem oluştururken kullanılmamalıdır.

---

## 5. Orta önem bulguları

### M-01 — Başarılı doğrudan WETH pool swap’i receipt uzlaştırmasında yanlışlıkla başarısız görünür

**Etkilenen kod:** `src/curb/FeeHook.sol:630-643`, `web/app.js:2624-2728`.

WETH pool’unda PoolManager iki fee bacağını ayrı recipient’lara göndermez. Birleşik `charged` tutarını hook’a tek WETH transferiyle yollar; hook unwrap edip ETH/WETH olarak dışarı öder. UI ise `reconcileSwap()` içinde PoolManager kaynaklı iki ayrı ERC-20 fee transferi bekler. Bu nedenle hem WETH buy hem WETH sell normal şekilde mine olsa da `out.reconciles` false olur ve “pool actually paid out” uyuşmazlığı gösterilir.

Bu fon kaybı değildir; kullanıcıya başarılı işlemden sonra yanlış alarm verir. Önceki tekrar gönderme olayları düşünüldüğünde yanlış başarı raporu operasyonel olarak önemlidir. Mevcut browser testleri WETH rotasının calldata’sını denetliyor; doğrudan WETH pool işleminden sonraki bu receipt yolunu uçtan uca sınamıyor.

**Çözüm yönü:** WETH payout modelini ayrı uzlaştır; PoolManager→hook birleşik WETH transferini, hook `Withdrawal`, `PaidAsNative/PaidAsWrapped` olaylarını ve trader netini aynı varlık dönüşüm zinciri olarak doğrula.

### M-02 — v4 önizleme initialized tick geçişlerini modellemiyor

**Etkilenen kod:** `web/app.js:921-967`.

`quotePoolSwap()` yalnız mevcut `sqrtPriceX96` ve aktif `liquidity` değerini kullanarak tek aralık formülü çalıştırıyor. Initialized tick listesi okunmuyor; fiyat bir tick sınırını geçtiğinde yeni likidite seviyesi uygulanmıyor. Açılışta tek full-range pozisyon varken hesap tutabilir. Hook üçüncü taraf likidite eklemeyi engellemediği için sonradan dar aralıklı pozisyonlar eklenebilir ve quote gerçek execution’dan ayrılır.

Min-out fon kaybını sınırlar; ancak kullanıcıya gösterilen çıktı, yürütme maliyeti ve önerilen min-out gereksiz revert veya yanıltıcı önizleme üretebilir.

Uniswap’ın resmî dokümanı, fiyat bir tick sınırına geldiğinde o aralıktaki likiditenin bitip yeni pozisyonların aktive edildiğini açıklar: <https://developers.uniswap.org/docs/get-started/concepts/liquidity-providers/concentrated-liquidity#ticks>.

**Çözüm yönü:** StateView/tick bitmap üzerinden gerçek v4 swap simülasyonu veya güvenilir quoter kullan; tek-range formülünü yalnız doğrulanmış tick-crossing olmayan küçük işlem alanıyla sınırla.

### M-03 — v3 rota adayları gerçek kotadan önce custody ile eleniyor

**Etkilenen kod:** `web/app.js:1643-1746`.

Kod her pair için tier’ları pool’un tuttuğu token bakiyesine göre sıralıyor, yalnız ilk direct tier’ı ve USDC yolunun yalnız ilk iki tier’ını candidate yapıyor. QuoterV2 daha sonra yalnız kalan iki yolu karşılaştırıyor. Elenmiş tier’lar gerçek işlem boyutunda daha iyi output verebilir.

Custody, concentrated liquidity’nin aktif fiyat aralığını, tick dağılımını veya yön bazlı execution kalitesini ölçmez. Aynı candidate set alış ve ters çevrilmiş satışta da kullanılıyor; bir asset’in en çok tutulduğu pool onun ters yönde en iyi çıktıyı verdiğini göstermez.

**Etki:** Kullanıcı geçerli ama daha pahalı bir ETH giriş/çıkış yolu seçebilir. Min-out kötü kotayı güvenli hale getirmez; yalnız kotanın altında yürütmeyi engeller.

**Çözüm yönü:** Mevcut bütün tier/path kombinasyonlarını gerçek miktarda QuoterV2 ile fiyatla; performans için adresleri cache’le, ekonomik adayları custody ile eleme.

### M-04 — Registry deployer süresiz canonical launcher yöneticisi olarak kalıyor

**Etkilenen kod:** `src/curb/LaunchRegistry.sol:158-176`, `:228-231`, `:269-288`.

Registry’nin `deployer` adresi immutable; `addLauncher()` için süre, gecikme, multisig doğrulaması, yetki devri veya renounce yolu yok. Eklenen launcher kaldırılamıyor. `_checkLoopCloses`, factory’nin wiring şeklini doğrular; factory’nin ekonomik/ürün davranışının mevcut canonical factory ile aynı olduğunu kanıtlamaz.

**Etki:** Deployer anahtarı ele geçirilirse saldırgan kendi factory’sini canonical discovery listesine kalıcı ekleyebilir. Anahtar kaybolursa yeni RWA factory’leri eklenemez. Bu fonları mevcut kontratlardan doğrudan çalmaz; canonical güven kökünü süresiz bir anahtara bağlar.

**Çözüm yönü:** Governance modelini açıkça sabitle; gecikmeli/multisig kontrollü admission, codehash/terms doğrulaması veya bütün asset factory’leri eklendikten sonra geri döndürülemez yetki kapatma yolu kullan.

### M-05 — Launch fee korumasız harici çağrı ile platform recipient’a gönderiliyor

**Etkilenen kod:** `src/curb/CurbLaunchFactory.sol:488-551`; deploy edilen fee `script/DeployCurb.s.sol:497` içinde `0.0005 ether`.

`launch()` henüz state/deployment yapmadan `platformTo.call{value: launchFee}("")` çağrısı yapıyor. Reentrancy guard yoktur.

İki sonuç vardır:

- Recipient ETH kabulünü revert ederse herkes için yeni launch açılması durur.
- Recipient callback’inde tekrar `launch{value: launchFee}` çağırabilir. Fee tekrar aynı recipient’a döndüğü için kontrollü bir callback guard ile recipient kendi nested launch’ını ekonomik olarak fee ödemeden oluşturabilir; outer launch daha sonra devam eder.

Bu, platform recipient/policy owner güven sınırı içindedir; permissionless saldırgan tek başına tetikleyemez. Buna rağmen launch fee’nin spam/ekonomik kapı işlevini ve protokol availability’sini mutable harici koda teslim eder.

Solidity dokümanı `call` ile ETH gönderiminin alıcı koda kontrol verdiğini vurgular: <https://docs.soliditylang.org/en/latest/security-considerations.html#reentrancy>.

**Çözüm yönü:** Launch fee’yi pull accounting’de biriktir; launch fonksiyonunda recipient kodu çalıştırma. En azından açık reentrancy guard ve recipient failure için protokolü durdurmayan tahsilat tasarımı gerekir.

### M-06 — Uygulama canonical deploy kimliğini doğrulamıyor

**Etkilenen kod:** `web/app.js:227-283`, `:300-363`.

Uygulama `rpc`, `factory`, `lens` ve `token` adreslerini URL query veya localStorage’dan alıyor. `beginAction` bunları kendi içinde tutarlı biçimde pinliyor ve wallet chain’i RPC chain’iyle karşılaştırıyor; ancak factory/lens’in ürünün yayımladığı canonical adresler olduğunu, bytecode/hash’i veya registry kökünü doğrulamıyor.

Bir phishing linki aynı chain’de kötü niyetli factory/lens adresleri verebilir. UI interface-shaped cevapları kabul edip quote asset için allowance açabilir ve `launch()` gönderebilir. Bu davranış yerel demo/geliştirme aracı için bilinçli olabilir; public production frontend aynı esnekliği korursa güvenlik açığına dönüşür.

**Çözüm yönü:** Production build’de chainId→canonical address book ve bytecode/config doğrulaması kullan. Custom deployment modu ayrı, belirgin ve işlem öncesi sürekli uyarılı olmalı.

---

## 6. Düşük önem bulguları

### L-01 — “Launch dolabilir” göstergesi pool custody’sini executable depth sayıyor

`web/app.js:1235-1284`, WETH/USDC karşısındaki en büyük raw quote-token bakiyesini threshold ile karşılaştırıyor. Pool’un threshold kadar token tutması, concentrated liquidity’nin mevcut aralıklarda bu miktarı kabul edilebilir fiyatla satabileceğini göstermez. Aşağı yöndeki sonuç yararlıdır: pool threshold’dan az tutuyorsa o pool tek başına threshold veremez. Yukarı yöndeki “enough” sonucu kanıt değildir.

Kullanıcı metni yalnız “holds X, needs Y” dese de yeterli durumda uyarıyı kaldırdığı için creator’a fiilen olumlu sinyal verir.

### L-02 — Dev-buy tavanı UI’da ikinci sabit olarak tutuluyor

`web/app.js:2356-2368` içinde `MAX_DEV_BUY_BPS = 7500n`, factory’nin `MAX_DEV_BUY_BPS = 7500` sabitini tekrarlar. Kontrat güvenliği etkilenmez; factory doğru sınırı uygular. İleride kontrat sabiti değişirse UI yanlış cap ve hata mesajı gösterir.

### L-03 — Token açıklaması sessizce 300 karaktere kesiliyor

`web/app.html:323-325` textarea için `maxlength` veya limit mesajı vermez; `web/app.js:2316-2321` açıklamayı sessizce `.slice(0, 300)` ile keser. Preview kullanıcının tam metnini gösterebilirken immutable token URI kırpılmış metni kalıcı saklar.

### L-04 — Lens sayfası caller’ın istediği kadar dış okuma yapıyor

`LaunchRegistry.launchSlice(start,count)` yalnız mevcut liste boyuna göre kısa döner; `LaunchLens.launchPage()` dönen her token için `this.launchState()` çağırır ve her state birden çok harici kontrat okuması yapar (`src/curb/LaunchLens.sol:132-151`). Çok büyük listede public RPC çağrısı gas/time limitine çarpabilir. View olduğu için zincir fonu etkilenmez; discovery RPC’si için DoS/operasyon riskidir.

---

## 7. Kod kusuru olarak sınıflandırılmayan mainnet riskleri

### R-01 — B20 issuer yetkisi sistemin bir parçasıdır

B20 pause, receiver policy, seize ve upgrade davranışları Curb’un kontrolü dışındadır. H-02 somut entegrasyon kusurudur; bunun ötesinde issuer’ın transferleri durdurması tasarımın doğal karşı taraf riskidir. UI ve şartlar bunu “ERC-20 gibi her zaman aktarılabilir” diye sunmamalıdır.

### R-02 — Referans fiyatı ve piyasa saatleri koruması yoktur

Min-out yalnız yürütme anındaki pool kotasını korur. RWA’nın dış referans fiyatından kopmasını, hafta sonu/kapalı piyasa fiyatını veya oracle staleness’i sınırlamaz. PRE_MAINNET B1/B2 açık kalmalıdır.

### R-03 — Fee policy canlı pool’ları etkiler, curve snapshot’larını etkilemez

Platform recipient ve platform bps değişikliği 24 saat gecikmeyle bütün mevcut mezun pool’lara ulaşır. Önceden açılmış curve’ler launch anındaki snapshot’ı korur. Bu bilinen yönetişim modelidir; kullanıcı şartlarında mezuniyet öncesi/sonrası ayrımı net olmalıdır.

### R-04 — Safe-shaped kontrol gerçek Safe güvenliğini kanıtlamaz

`DeployCurb.platformRecipient()` yalnız code size ile `getOwners()/getThreshold()` cevaplarını okur ve loglar; sonuçları beklenen owner/eşikle karşılaştırmaz, implementation/proxy, guard, fallback handler ve enabled module denetlemez. `preflight-mainnet.sh` ayrıca EOA override’ını varsayılan `true` verir. Mevcut PRE_MAINNET kararı EOA’yı geçici olarak kabul ettiği için bu bulgu “Safe zorunluluğu ihlali” değildir; deploy doğrulamasının sağladığı güvencenin sınırıdır.

Safe’in resmî dokümanı modüllerin keyfi işlem çalıştırabildiğini ve kötü niyetli modülün Safe’i ele geçirebileceğini belirtir: <https://docs.safe.global/advanced/smart-account-modules>.

### R-05 — Lisans, dış audit ve gerçek deploy kanıtı yoktur

v4-core BUSL hukuki pozisyonu, bağımsız dış audit, Base mainnet adres defteri, explorer verification ve yayımlanan bytecode/repo commit eşleşmesi tamamlanmadan production readiness iddia edilmemelidir.

---

## 8. Doğrulamalar

### Yerel testler

```text
forge test --no-match-path "test/fork/*"
61 passed, 0 failed, 0 skipped — 7 suite
```

Araç: stock Forge `1.7.1`.

### Kritik Base fork kontrolleri

Pinlenmiş blok: `51171034` (`0x30cceda`). Araç: `base-forge 1.6.0-v1.1.0`.

```text
test_wethPool_aCreatorCanStopEverySwapByReenteringTheManager
1 passed, 0 failed

test_aBlockedRecipientIsRefusedWithPolicyForbids
test_oneBlocklistEntryStopsTwoDifferentAssets
2 passed, 0 failed
```

### Build/lint

- `forge build --sizes`: bütün production kontratları EIP-170 sınırı altında.
- En dar production kontratı `CurbLaunchFactory`: runtime `20,857` byte, yaklaşık `3,719` byte marj.
- `forge lint` production tarafında unsafe-cast/divide-before-multiply/timestamp uyarıları verdi. İncelenen cast’ler mevcut range kontrolleri veya Uniswap int128 veri tipiyle sınırlıydı; bu denetimde ayrı exploitable bulguya yükseltilmedi. Graduator tick bölmesi negatif değerlerde sıfıra doğru truncation yapıyor ancak sonrasında min/max tick’e genişlettiği için likidite aralığını daraltmıyor.

### Çalıştırılmayanlar

- Bütün fork suite bu snapshot’ta tekrar çalıştırılmadı.
- Browser suite, eşzamanlı olarak `web/app.js` ve spec dosyaları değiştirildiği için bu audit koşusunda yeniden çalıştırılmadı.
- Dolayısıyla daha önce bildirilmiş “tam suite yeşil” sonuçları bu raporun bağımsız kanıtı olarak kullanılmadı.

## 9. Olumlu kontroller

- Curve ücret muhasebesi escrow ile trading/graduation’ı creator teslimatından ayırıyor.
- FeeEscrow claim yolu giriş ve çıkış bakiye deltalarını, reentrancy’yi ve kısa/fazla ödeme token davranışlarını kapsamlı biçimde sınamış.
- Pool minimum-output sınırı son varan asset’e uygulanıyor ve revert bütün iki-bacaklı rotayı atomik geri alıyor.
- Exact-output ve kısmi exact-input buy davranışları açıkça fail-closed.
- Hook configuration yalnız graduator’dan ve registry’deki write-once launch kaydından kuruluyor.
- Create factory ekonomik parametreleri caller’dan almıyor; tax bandı ve immutable terms kontrat tarafında uygulanıyor.
- Receipt sonrası okuma hatası mined işlemi başarısızmış gibi göstermeyen ayrı raporlama yoluna alınmış.
- Mainnet deploy script’i sıfır recipient’ı reddediyor ve EOA kullanımı için açık override istiyor; preflight varsayılanının bu korumayı zayıflattığı R-04’te kaydedildi.

## 10. Öncelik sırası

1. **H-01:** Swap callback’i içindeki native creator çağrısını kaldırmadan WETH quote factory production’a alınmamalı.
2. **H-02:** B20 pool fee ödemesi receiver policy failure’dan ayrıştırılmadan RWA havuzları production’a alınmamalı.
3. **H-03:** Create action dev-buy değerini yalnız pinned factory context’iyle kurmalı.
4. **M-01:** WETH receipt uzlaştırması gerçek payout modeline göre sınanmalı.
5. **M-02/M-03/L-01:** Quoting ve routing concentrated-liquidity gerçekliğine bağlanmalı.
6. **M-04/M-05/R-04:** Deploy/governance güven kökü ve fee tahsilatı netleştirilmeli.
7. Bulgular düzeltildikten sonra tam non-fork, tam fork, browser, mutation suite ve bağımsız dış audit temiz commit üzerinde tekrarlanmalı.

## 11. Kaynaklar

- Base B20 standardı ve compliance akışı: <https://github.com/base/base-std/blob/main/docs/overview.md>
- Base standard implementation/documentation repository: <https://github.com/base/base-std>
- Uniswap v4 PoolManager arayüzü: <https://github.com/Uniswap/v4-core/blob/main/src/interfaces/IPoolManager.sol>
- Uniswap concentrated liquidity ve tick davranışı: <https://developers.uniswap.org/docs/get-started/concepts/liquidity-providers/concentrated-liquidity>
- Solidity güvenlik değerlendirmeleri: <https://docs.soliditylang.org/en/latest/security-considerations.html>
- Safe module güvenlik modeli: <https://docs.safe.global/advanced/smart-account-modules>

Bu rapor bulguları düzeltmez; yalnızca yukarıdaki anlık görüntü için yeniden doğrulanmış inceleme sonucudur.
