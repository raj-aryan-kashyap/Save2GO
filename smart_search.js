// ================================================================
//  smart_search.js  —  AI Smart Search & Custom Filters  (v2)
//  5-layer hybrid architecture:
//    L1: Master tag vocabulary (hardcoded, easy to update)
//    L2: Synonym/jargon map (client-side, instant)
//    L3: Phase 1 fuzzy matching → neutral chips + instant results
//    L4: Phase 2 constrained AI (Gemini picks from known tags only)
//    L5: Tag chip UI — removable, Reset link, live count
//
//  DEPENDENCIES  (globals provided by aap.js, loaded before this file)
//    API_URL                        — GAS web-app endpoint
//    travelSpots                    — live spots array
//    currentUser                    — active user string
//    renderList()                   — triggers list re-render
//    updateHeaderBadgeHUDCounters() — refreshes count badges
//    plotDynamicMarkersOnCanvasMap() — (optional) refreshes map pins
// ================================================================


/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   LAYER 1 — MASTER TAG VOCABULARY
   Keep in sync with Column Q of MasterVault and the
   MASTER_TAGS_LIST in ai_assist_backend.gs
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

const _SS_MASTER_TAGS = [
    'Accessibility','Activity','Adventure','Aesthetic','Affordable',
    'Agriculture','Alpine','Animals','Antique','Architecture',
    'Archive','Art','Art gallery','Art market','Art Nouveau',
    'Artistic','Atmosphere','Authentic','Bakery','Balcony',
    'Baroque','Beauty','Botanical','Boutique','Brasserie',
    'Bridge','Bridges','Budget','Budget-friendly','By water',
    'Canal boat ride','Cars','Castle','Cathedral','Central',
    'Charming','Chic','Cinema','Cinematic','City',
    'City view','City views','Cityscape','Cliffs','Coastal',
    'Cobblestone','Colorful','Composition','Contemporary','Cozy',
    'Craft beer','Creative','Culture','Custom','Dark academia',
    'Day trip','Design','Designer','Eerie','Eiffel Tower',
    'Elegant','Elevated','Experience','Exterior','Facades',
    'Fairytale','Farm','Fashion','Film location','Filming location',
    'Floral','Flowers','Food','Food and wine','Forest',
    'Fountains','Framed','Framing','Futuristic','Garden',
    'Gardens','Geometric','Gifts','Glass dome','Glass pyramid',
    'Glass roof','Gothic','Gourmet','Green space','Greenery',
    'High-energy','High-tech','Hiking','Hilltop','Historic',
    'Historic site','History','Hidden gem','Hidden-gem','Iconic',
    'Immersive','Indoor','Industrial','Innovative','Interactive',
    'Interior','Islamic motifs','Keepsake','Landmark','Landmark proximity',
    'Landmark square','Landscape','Language','Lavender','Library',
    'Lifestyle','Lights','Lively','Local','Louvre',
    'Luxury','Magical','Mall','Marais','Market',
    'Medieval','Memorial','Modern','Monument','Monumental',
    'Moody','Mountain','Mountainous','Mountains','Movie location',
    'Museum','Music','Nature','Neoclassical','Night',
    'Nightlife','Nighttime','Non-tourist','Non-Tourist','Nostalgic',
    'Obelisk','Open-air museum','Ornate','Outdoor','Outdoors',
    'Outerwear','Panoramic','Panoramic view','Panoramic views','Panorama',
    'Paris','Park','Parklands','Pastel','Path',
    'Peaceful','Pedestrian','Performance','Perspective','Perspective trick',
    'Photo','Photo spot','Picnic','Pink blooms','Plaza',
    'Poem','Poetic','Pop-culture','Port de L\'Alma','Portrait',
    'Pose','Quiet','Reading room','Reel','Reflection',
    'Reflections','Religious','Residential','Restaurant','Retro',
    'River','Riverside','Road trip','Rocks','Romantic',
    'Rooftop','Royal chapel','Royal garden','Ruins','Rural',
    'Sakura','Scenic','Science','Sculpture','Secret spot',
    'Seine','Serene','Shaded','Shopping','Skate',
    'Skincare','Skyline','Solo dining','Solo photo','Souvenir',
    'Souvenirs','Spring','Stained glass','Stairs','Statues',
    'Street life','Street photography','Street scene','Street view','Street food',
    'Street-style','Stroll','Suburban','Sunset','Symmetrical',
    'Symmetry','Taproom','Technology','Terrace','Thrift',
    'Town','Tracking shots','Traditional','Transit','Trees',
    'Trendy','UNESCO','Underworld','Unique','Urban',
    'Urban explorer','Valley','Viewpoint','Vintage','Vintage cars',
    'Vineyard','Vineyards','Waterfall','Whimsical','Wine',
    'Wine route',
];


/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   LAYER 2 — SYNONYM / JARGON BANK
   Keys = canonical tag (must match _SS_MASTER_TAGS exactly)
   Values = array of synonyms (lowercase, all forms)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

const _SS_SYNONYM_BANK = {
    'Accessibility':      ['wheelchair','accessible','disabled','mobility','ada','barrier free'],
    'Activity':           ['things to do','activities','experiences','stuff to do','action'],
    'Adventure':          ['thrill','exciting','adrenaline','extreme','adventurous','bold','daring'],
    'Aesthetic':          ['beautiful','pretty','gorgeous','instagrammable','insta worthy','gram worthy','aesthetic spot','visually pleasing','ig worthy'],
    'Affordable':         ['cheap','inexpensive','free','low cost','budget friendly','wallet friendly','no cost','gratis'],
    'Agriculture':        ['farm','farming','crops','rural','fields','countryside farming'],
    'Alpine':             ['alps','mountain village','ski','altitude','high altitude','mountain resort'],
    'Animals':            ['wildlife','zoo','birds','fauna','creatures','pets','horses','cats','dogs'],
    'Antique':            ['antiques','vintage shop','flea market','old stuff','collectibles','brocante'],
    'Architecture':       ['building','buildings','structure','architectural','designed','construction'],
    'Archive':            ['records','documents','library archive','historical records'],
    'Art':                ['artwork','paintings','exhibition','gallery art','creative art','mural','installation','tapestry'],
    'Art gallery':        ['gallery','art museum','exhibition space','art exhibition','contemporary gallery'],
    'Art market':         ['art fair','craft market','artist market','gallery market'],
    'Art Nouveau':        ['art nouveau building','nouveau style','organic architecture','belle epoque'],
    'Artistic':           ['creative','artist','studio','hand crafted','handmade','crafted'],
    'Atmosphere':         ['ambiance','vibe','feeling','mood','character','spirit','soul of the place'],
    'Authentic':          ['genuine','real','traditional','original','local culture','not touristy'],
    'Bakery':             ['bread','pastry','croissant','boulangerie','patisserie','baked goods','brioche','cake shop'],
    'Balcony':            ['terrace view','balcony view','overhang','overlook balcony'],
    'Baroque':            ['ornate','classical','elaborate','baroque style','17th century'],
    'Beauty':             ['beautiful','stunning','gorgeous','lovely','scenic','pretty'],
    'Botanical':          ['botanic garden','greenhouse','plants','flora','plant collection','herbarium'],
    'Boutique':           ['small shop','independent shop','local shop','designer store','specialty shop'],
    'Brasserie':          ['french bistro','bistro','french restaurant','cafe restaurant','parisian cafe'],
    'Bridge':             ['overpass','viaduct','footbridge','pedestrian bridge','crossing'],
    'Bridges':            ['overpass','bridges','viaducts','footbridges','crossings'],
    'Budget':             ['cheap','free','affordable','low cost','inexpensive','no entry fee','budget travel'],
    'Budget-friendly':    ['cheap','affordable','free','low cost','value for money','economical'],
    'By water':           ['waterfront','by the water','water side','lakeside','waterside','riverside spot'],
    'Canal boat ride':    ['boat tour','canal tour','water taxi','river cruise','canal cruise','gondola'],
    'Cars':               ['vintage cars','classic cars','automobiles','car museum','vehicles'],
    'Castle':             ['chateau','fortress','palace','chteau','fort','stronghold','citadel'],
    'Cathedral':          ['church','basilica','minster','chapel','cathedral','dom','duomo'],
    'Central':            ['city centre','downtown','center','midtown','central location'],
    'Charming':           ['quaint','cute','adorable','lovely','picturesque','delightful','sweet'],
    'Chic':               ['stylish','fashionable','trendy','hip','sophisticated','smart'],
    'Cinema':             ['movies','film','theater','theatre','cinema hall','movie theatre','film screening'],
    'Cinematic':          ['movie like','film quality','cinematic shot','film worthy','dramatic','epic view'],
    'City':               ['urban','downtown','metropolitan','city centre','city center','town center'],
    'City view':          ['overlooking city','city panorama','skyline view','urban view','city overlook'],
    'City views':         ['overlooking city','city panorama','skyline views','urban views'],
    'Cityscape':          ['city landscape','urban landscape','city skyline','urban skyline'],
    'Cliffs':             ['cliff','rocky coast','coastal cliffs','sea cliffs','ocean cliffs','bluffs'],
    'Coastal':            ['seaside','coast','oceanfront','seashore','seafront','by the sea'],
    'Cobblestone':        ['cobbled streets','stone streets','old streets','cobbles','paved streets'],
    'Colorful':           ['colourful','vibrant','bright','multi colored','rainbow','vivid','saturated'],
    'Composition':        ['framing','photo composition','rule of thirds','leading lines','depth'],
    'Contemporary':       ['modern art','current art','present day','new art','now','contemporary design'],
    'Cozy':               ['cosy','warm','snug','intimate','comfortable','homely','welcoming','hygge'],
    'Craft beer':         ['brewery','microbrewery','local beer','ale','ipa','craft ale','taproom beer'],
    'Creative':           ['artistic','innovative','imaginative','original','design','craft'],
    'Culture':            ['cultural','heritage','tradition','customs','local culture','society'],
    'Dark academia':      ['academic aesthetic','moody library','gothic academia','studious','bookish','ivy league','scholarly'],
    'Day trip':           ['day excursion','short trip','day out','half day','nearby','day visit'],
    'Design':             ['architectural design','interior design','product design','design focused'],
    'Designer':           ['high end','luxury brand','couture','upscale','premium brand'],
    'Eerie':              ['spooky','ghostly','mysterious','haunted','creepy','uncanny','eerie atmosphere','dark'],
    'Eiffel Tower':       ['iron lady','tour eiffel','la tour eiffel','paris tower','eiffel','trocadero view','champ de mars','iron tower'],
    'Elegant':            ['sophisticated','refined','classy','graceful','poised','dignified'],
    'Elevated':           ['high up','on a hill','above ground','raised','hilltop view','aerial','elevated view'],
    'Experience':         ['unique experience','immersive','activity','attraction','must do'],
    'Exterior':           ['outside','outdoor photography','facade photo','building exterior'],
    'Facades':            ['building fronts','architecture facades','storefronts','house fronts'],
    'Fairytale':          ['fairy tale','fairy-tale','magical','enchanting','storybook','fantasy','dreamlike','whimsical castle'],
    'Farm':               ['farmhouse','countryside','rural','agriculture','farm stay','rural life'],
    'Fashion':            ['style','clothing','outfit','fashion shoot','style photography','clothing shoot'],
    'Film location':      ['movie location','movie set','filming spot','film set','tv location','on location'],
    'Filming location':   ['film location','movie spot','production location','tv filming','shot here'],
    'Floral':             ['flowers','blooms','flora','floral display','flower garden','in bloom'],
    'Flowers':            ['blooms','floral','flower garden','spring flowers','blossom','petals'],
    'Food':               ['eat','eating','cuisine','dining','food scene','meals','culinary','foodie'],
    'Food and wine':      ['food wine pairing','culinary wine','gastronomy','fine dining wine','wine and dine'],
    'Forest':             ['woods','woodland','trees','jungle','forest walk','wooded','timber'],
    'Fountains':          ['fountain','water feature','fountain square','water jets'],
    'Framed':             ['natural frame','framing shot','arch photo','window frame','doorway frame'],
    'Framing':            ['natural frame','framing technique','composition','arch','doorway photo'],
    'Futuristic':         ['sci-fi','modern architecture','high tech','space age','futuristic design','avant garde'],
    'Garden':             ['gardens','park garden','botanical','flower garden','public garden','green space'],
    'Gardens':            ['garden','park','botanical garden','ornamental garden','public gardens'],
    'Geometric':          ['patterns','shapes','symmetry','lines','grid','geometric design'],
    'Gifts':              ['souvenir shop','gift shop','presents','keepsakes','shopping'],
    'Glass dome':         ['dome','glass ceiling','glass structure','crystal palace','domed building'],
    'Glass pyramid':      ['pyramid','glass pyramid','louvre pyramid','modern pyramid'],
    'Glass roof':         ['glass ceiling','greenhouse roof','skylight','transparent roof'],
    'Gothic':             ['gothic architecture','medieval gothic','dark stone','pointed arches','gargoyles'],
    'Gourmet':            ['fine dining','cuisine','upscale food','foodie','michelin','gastronomy','chef restaurant'],
    'Green space':        ['park','garden','nature','open green','public park','grass','meadow'],
    'Greenery':           ['green','plants','foliage','lush','vegetation','nature','leafy'],
    'High-energy':        ['lively','vibrant','buzzing','energetic','busy','dynamic','active','electric'],
    'High-tech':          ['technology','futuristic','digital','smart','innovative tech','cutting edge'],
    'Hiking':             ['hike','trail','trekking','trek','walking trail','rambling','footpath','bushwalk'],
    'Hilltop':            ['hill','on the hill','top of hill','summit view','hillside','elevated spot'],
    'Historic':           ['historical','heritage','old','ancient','period building','centuries old','classic','history rich'],
    'Historic site':      ['historical site','ruins','monument','ancient site','heritage site','archaeological'],
    'History':            ['historical','heritage','past','old','historic','ancient','chronicle'],
    'Hidden gem':         ['hidden spot','secret spot','off the beaten path','undiscovered','local favorite','local secret','best kept secret'],
    'Hidden-gem':         ['hidden spot','secret spot','off beaten path','local favourite','undiscovered gem'],
    'Iconic':             ['famous','landmark','well known','iconic spot','must see','renowned','celebrated'],
    'Immersive':          ['interactive experience','fully immersive','360','engaging','hands on'],
    'Indoor':             ['inside','interior','covered','enclosed','indoor space','inside spot'],
    'Industrial':         ['warehouse','factory','industrial chic','brick','raw','loft'],
    'Innovative':         ['creative','inventive','new concept','cutting edge','ground breaking'],
    'Interactive':        ['hands on','touch','participate','engage','interactive exhibit'],
    'Interior':           ['inside','indoor','interior design','inside photo','interior decor'],
    'Islamic motifs':     ['arabic','moorish','islamic art','arabesque','geometric islamic','mosque art'],
    'Keepsake':           ['souvenir','memento','memory','gift','take home','memorabilia'],
    'Landmark':           ['monument','famous spot','well known place','tourist attraction','icon','must visit'],
    'Landmark proximity': ['near landmark','close to monument','landmark view','beside landmark'],
    'Landmark square':    ['main square','central square','plaza','public square','town square'],
    'Landscape':          ['scenic view','natural landscape','countryside','vista','panorama','scenery'],
    'Language':           ['language school','linguistic','translation','multilingual','foreign language'],
    'Lavender':           ['lavender field','lavender farm','purple flowers','provence','lavender season'],
    'Library':            ['books','reading','study','bookshelf','reading room','bibliothèque','bibliotheque'],
    'Lifestyle':          ['lifestyle photography','daily life','living','culture','way of life'],
    'Lights':             ['illuminated','lighting','lit up','night lights','neon','fairy lights','light show'],
    'Lively':             ['buzzing','busy','vibrant','animated','energetic','active','happening'],
    'Local':              ['local culture','neighbourhood','authentic local','off the beaten path','local favourite'],
    'Louvre':             ['louvre museum','musee du louvre','louvre palace','paris museum','glass pyramid'],
    'Luxury':             ['luxurious','high end','upscale','five star','5 star','premium','opulent','lavish'],
    'Magical':            ['enchanting','fairytale','dreamlike','whimsical','ethereal','otherworldly'],
    'Mall':               ['shopping centre','shopping mall','shopping center','retail mall','indoor shopping'],
    'Marais':             ['le marais','marais district','paris jewish quarter','marais paris'],
    'Market':             ['flea market','bazaar','street market','farmers market','local market','souq','souk','brocante'],
    'Medieval':           ['middle ages','medieval castle','old town','medieval village','fortress','ramparts'],
    'Memorial':           ['monument','tribute','remembrance','war memorial','cenotaph','commemoration'],
    'Modern':             ['contemporary','current','new','modern design','recent','present day'],
    'Monument':           ['memorial','obelisk','column','landmark','statue','historic monument'],
    'Monumental':         ['huge','grand','massive','imposing','majestic','large scale'],
    'Moody':              ['atmospheric','dark','dramatic','brooding','melancholic','overcast','misty'],
    'Mountain':           ['mountains','peak','summit','alpine','mountain range','highland'],
    'Mountainous':        ['mountains','hilly','alpine terrain','mountain landscape','elevated terrain'],
    'Mountains':          ['mountain','peaks','summits','alps','highlands','ranges'],
    'Movie location':     ['film location','filming location','movie set','film set','tv show location'],
    'Museum':             ['gallery','exhibition','collection','cultural institution','art house'],
    'Music':              ['live music','concert','gig','bands','performance','music venue','jazz','classical music'],
    'Nature':             ['natural','outdoors','wildlife','environment','countryside','greenery'],
    'Neoclassical':       ['classical style','greek revival','roman columns','pillars','neoclassic','columned building'],
    'Night':              ['nighttime','evening','after dark','night photography','dusk','nocturnal'],
    'Nightlife':          ['bars','clubs','party','going out','evening entertainment','club scene','bar hopping'],
    'Nighttime':          ['night','after dark','evening','nocturnal','nightly','late night'],
    'Non-tourist':        ['off the beaten path','locals only','non touristy','authentic','away from crowds'],
    'Non-Tourist':        ['off beaten path','local spot','non touristy','authentic local','hidden'],
    'Nostalgic':          ['vintage feel','retro','old school','throwback','reminiscent','sentimental'],
    'Obelisk':            ['monument','column','needle','spire','tall monument'],
    'Open-air museum':    ['outdoor museum','open air','sculpture garden','outdoor exhibition'],
    'Ornate':             ['elaborate','decorative','embellished','detailed','intricate','opulent'],
    'Outdoor':            ['outdoors','outside','open air','al fresco','exterior','in the open'],
    'Outdoors':           ['outdoor','outside','open air','nature','exterior'],
    'Outerwear':          ['jacket','coat','fashion outerwear','winter fashion','street style fashion'],
    'Panoramic':          ['panorama','wide view','sweeping view','scenic view','vista','wide angle'],
    'Panoramic view':     ['panorama','wide view','city panorama','sweeping vista','360 view'],
    'Panoramic views':    ['panorama views','wide views','sweeping views'],
    'Panorama':           ['panoramic','wide view','sweeping vista','full view','360'],
    'Paris':              ['parisian','paris france','city of light','french capital','ile de france'],
    'Park':               ['green space','garden','nature reserve','public park','parkland','grounds'],
    'Parklands':          ['park','open land','green belt','public parkland','lawns'],
    'Pastel':             ['soft colors','muted tones','pastel colors','soft hues','pale','light colors'],
    'Path':               ['pathway','trail','walkway','footpath','alley','lane'],
    'Peaceful':           ['serene','tranquil','quiet','calm','relaxing','chill','zen','undisturbed','restful','still'],
    'Pedestrian':         ['walking','pedestrianised','car free','walkable','foot traffic','promenade'],
    'Performance':        ['show','live performance','theater performance','dance','concert','entertainment'],
    'Perspective':        ['angle','viewpoint','vantage','point of view','perspective shot'],
    'Perspective trick':  ['forced perspective','optical illusion','trick shot','creative angle'],
    'Photo':              ['photography','shoot','photo shoot','take photos','capture','snap'],
    'Photo spot':         ['instagram spot','photo opportunity','instagrammable','photogenic','content spot','photo wall'],
    'Picnic':             ['picnic spot','outdoor dining','park lunch','al fresco picnic','lawn','grass area'],
    'Pink blooms':        ['pink flowers','cherry blossom','pink blossoms','sakura pink','floral pink'],
    'Plaza':              ['square','public square','piazza','platz','main square','open space'],
    'Poem':               ['poetry','literary','poetic place','verse','romantic words'],
    'Poetic':             ['romantic','dreamy','literary','atmospheric','lyrical','evocative'],
    'Pop-culture':        ['pop culture','trending','social media','viral','influencer','tiktok','pop reference'],
    'Port de L\'Alma':    ['alma bridge','pont de l alma','paris riverbank','diana memorial','seine bank'],
    'Portrait':           ['portrait photography','solo portrait','headshot','face photo','model shoot'],
    'Pose':               ['posing','photo pose','instagram pose','model pose','outfit photo'],
    'Quiet':              ['peaceful','serene','calm','tranquil','silent','hushed','undisturbed'],
    'Reading room':       ['library','study room','reading','books','quiet study','reading hall','lecture room'],
    'Reel':               ['short video','clip','footage','instagram reel','reels','video content','b-roll','cinematic shots','tiktok','content creation','short film','video reel'],
    'Reflection':         ['reflections','mirror effect','water reflection','glass reflection','puddle reflection'],
    'Reflections':        ['reflection','mirror','mirrored','water mirror','symmetrical reflection'],
    'Religious':          ['church','mosque','temple','spiritual','sacred','holy','faith','worship','shrine'],
    'Residential':        ['neighborhood','neighbourhood','suburb','residential area','houses','homes'],
    'Restaurant':         ['dining','eat','cuisine','food','eatery','dining spot','dine','bistro'],
    'Retro':              ['vintage','old school','nostalgic','throwback','classic','decades past'],
    'River':              ['riverside','waterfront','waterway','riverbank','stream','creek'],
    'Riverside':          ['river','by the river','riverfront','riverside walk','river bank'],
    'Road trip':          ['drive','driving','scenic drive','road journey','car trip','route'],
    'Rocks':              ['rocky','boulders','stone','cliff face','rock formation'],
    'Romantic':           ['romance','couple','date night','love','date spot','lovers','honeymoon'],
    'Rooftop':            ['roof','terrace roof','sky bar','rooftop bar','rooftop view','top floor view'],
    'Royal chapel':       ['chapel','palace chapel','royal church','sainte chapelle','palatine chapel'],
    'Royal garden':       ['palace garden','royal park','versailles garden','formal garden'],
    'Ruins':              ['ruined','ancient ruins','historic ruins','archaeological','remains','remnants'],
    'Rural':              ['countryside','village','farm','pastoral','country life','rural landscape'],
    'Sakura':             ['cherry blossom','cherry blossoms','spring blossom','pink blossom','japanese blossom','hanami'],
    'Scenic':             ['beautiful view','picturesque','landscape','scenic spot','scenic route','view'],
    'Science':            ['science museum','technology','stem','exhibits','discovery','innovation'],
    'Sculpture':          ['statue','art installation','bronze','sculpture garden','public art'],
    'Secret spot':        ['hidden gem','off beaten path','local secret','undiscovered','locals only','quiet spot'],
    'Seine':              ['river seine','seine river','paris river','seine bank','along the seine'],
    'Serene':             ['peaceful','tranquil','quiet','calm','still','undisturbed','restful'],
    'Shaded':             ['shade','shadowy','covered walkway','canopy','tree shade','cool spot'],
    'Shopping':           ['shops','store','retail','boutiques','mall','shopping district','market','buy'],
    'Skate':              ['skateboard','skatepark','skating','skate spot','skater'],
    'Skincare':           ['beauty','spa treatment','facial','skin','beauty routine'],
    'Skyline':            ['city view','cityscape','skyline view','city silhouette','roofline'],
    'Solo dining':        ['eating alone','solo restaurant','single diner','solo meal','table for one'],
    'Solo photo':         ['solo shoot','alone photo','solo portrait','self portrait','solo shot'],
    'Souvenir':           ['gifts','keepsake','memorabilia','take home','trinkets','mementos'],
    'Souvenirs':          ['gifts','keepsakes','memorabilia','trinkets','souvenir shop'],
    'Spring':             ['springtime','spring season','blooming','spring flowers','spring vibes'],
    'Stained glass':      ['glass windows','cathedral glass','colored glass','rose window','church windows'],
    'Stairs':             ['steps','staircase','stairway','ladder','stone steps','spiral stairs'],
    'Statues':            ['statue','sculpture','bronze figure','monument','figurine'],
    'Street life':        ['street scene','city life','urban life','people watching','candid'],
    'Street photography': ['street photo','candid','documentary photography','street scene','urban photography'],
    'Street scene':       ['street life','urban scene','city street','street view'],
    'Street view':        ['street level','road view','at street level','google street view','walkable'],
    'Street food':        ['local food','food stall','vendors','hawker','food cart','street eats','local cuisine'],
    'Street-style':       ['fashion','outfit photo','street fashion','lookbook','style shot'],
    'Stroll':             ['walk','wander','meander','leisurely walk','promenade','amble'],
    'Suburban':           ['suburb','residential','outskirts','neighbourhood','quiet street'],
    'Sunset':             ['golden hour','dusk','evening light','sunset view','sundown','magic hour'],
    'Symmetrical':        ['symmetry','balanced','mirrored','centered','perfect symmetry'],
    'Symmetry':           ['symmetrical','balanced','mirrored','centered','geometric symmetry'],
    'Taproom':            ['brewery taproom','tap room','craft beer bar','brewing company','microbrewery bar'],
    'Technology':         ['tech','science','innovation','digital','gadgets','modern tech'],
    'Terrace':            ['outdoor seating','patio','garden seating','terrace bar','outdoor terrace'],
    'Thrift':             ['thrift shop','secondhand','vintage shopping','charity shop','op shop','thrifting','pre-loved'],
    'Town':               ['village','small town','town center','market town','local town'],
    'Tracking shots':     ['moving shot','video tracking','panning shot','follow shot','cinematic movement'],
    'Traditional':        ['heritage','cultural','authentic','classic','old fashioned','time honoured'],
    'Transit':            ['metro','subway','train','transport','public transit','station'],
    'Trees':              ['forest','woodland','nature','tree lined','canopy','wooded'],
    'Trendy':             ['hip','fashionable','popular','hot spot','on trend','in vogue','buzzing'],
    'UNESCO':             ['world heritage','heritage site','world heritage site','protected site','historic preservation'],
    'Underworld':         ['catacombs','underground','subterranean','caves','underground city','tunnels'],
    'Unique':             ['one of a kind','unusual','quirky','different','out of the ordinary','special'],
    'Urban':              ['city','downtown','metropolitan','urban area','inner city'],
    'Urban explorer':     ['urbex','abandoned','forgotten places','exploring city','urban exploration'],
    'Valley':             ['valley view','gorge','canyon','ravine','dale','glen'],
    'Viewpoint':          ['lookout','vista','overlook','vantage point','observation point','belvedere'],
    'Vintage':            ['retro','antique','old','classic','period','old style'],
    'Vintage cars':       ['classic cars','old cars','car show','automobile museum','retro vehicles'],
    'Vineyard':           ['wine','winery','wine tasting','grape','estate','domaine'],
    'Vineyards':          ['vineyard','wine region','wine estate','wine country','grape growing'],
    'Waterfall':          ['cascade','falls','waterfalls','waterfall hike','water drop'],
    'Whimsical':          ['magical','fairytale','dreamlike','quirky','playful','imaginative','fantastical'],
    'Wine':               ['wine bar','wine tasting','winery','vineyard','vino','vin','sommelier'],
    'Wine route':         ['wine trail','wine road','wine journey','wine region tour','vignoble'],
};


/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   AUTO-BUILD REVERSE MAP (synonym → canonical tag)
   Built once at parse time — O(1) lookups at runtime
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

const _SS_REVERSE_MAP = (() => {
    const map = {};
    // 1. Every master tag maps to itself (lowercase → canonical)
    for (const tag of _SS_MASTER_TAGS) {
        map[tag.toLowerCase()] = tag;
        // Also map first word of multi-word tags
        const firstWord = tag.split(' ')[0].toLowerCase();
        if (firstWord.length >= 4 && !map[firstWord]) {
            map[firstWord] = tag;
        }
    }
    // 2. Every synonym maps to its canonical tag
    for (const [canonical, synonyms] of Object.entries(_SS_SYNONYM_BANK)) {
        for (const syn of synonyms) {
            if (!map[syn.toLowerCase()]) {
                map[syn.toLowerCase()] = canonical;
            }
        }
    }
    return map;
})();


/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   SCORING CONSTANTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

// Phase 2 AI confidence → score multiplier
const _SS_CONFIDENCE_WEIGHT = { high: 3, medium: 2, low: 1 };
// Phase 1 local — all tags start as 'medium' confidence
const _SS_P1_CONFIDENCE_WEIGHT = { high: 2, medium: 1.5, low: 1 };

// Spot field → base score when a tag matches that field
const _SS_FIELD_SCORE = {
    search_keywords : 3,   // Column Q — curator tags (most reliable)
    category        : 2,   // spot category
    spot_name       : 2,   // spot name contains the tag word
    notes           : 1,   // short notes
    long_description: 1,   // prose description
};

// Cache version — changing this auto-invalidates v1 keyword-based cache
const _SS_CACHE_VERSION = 'v2';


/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   STORAGE KEY HELPERS  (per-user, using currentUser)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function _ssUserKey() {
    return (typeof currentUser === 'string' && currentUser.trim())
        ? currentUser.trim().toLowerCase().replace(/\s+/g, '_')
        : 'default';
}
// v2 cache uses a different key name — old v1 cache is ignored automatically
const _SS_CACHE_KEY   = () => `compass_search_cache_v2_${_ssUserKey()}`;
const _SS_FILTERS_KEY = () => `compass_custom_filters_${_ssUserKey()}`;
const _SS_ACTIVE_KEY  = () => `compass_active_custom_filter_${_ssUserKey()}`;


/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   IN-MEMORY STATE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

let _ssFilters   = [];        // array of custom filter objects
let _ssCache     = {};        // { [normKey]: { _v, filterName, tags, savedAt } }
let _ssActiveIds = new Set(); // IDs of currently active filters (OR union logic)
let _ssBusy      = false;     // debounce — prevent double-submit
let _ssChipState = null;      // session-only chip refinement state (not persisted)
// _ssChipState shape:
// { filterId, allTags: [{tag,confidence}], activeTags: Set<string>,
//   spotTagMatches: {rowid:{tag:fieldScore}}, confidenceWeights: {tag:number},
//   refinedRowIds: string[], phase: 'p1'|'p2'|'user' }


/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   INIT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function initSmartSearch() {
    try {
        _ssFilters = JSON.parse(localStorage.getItem(_SS_FILTERS_KEY()) || '[]');
        _ssCache   = JSON.parse(localStorage.getItem(_SS_CACHE_KEY())   || '{}');
        const savedActive = JSON.parse(localStorage.getItem(_SS_ACTIVE_KEY()) || '[]');
        const validIds    = new Set(_ssFilters.map(f => f.id));
        _ssActiveIds = new Set(
            Array.isArray(savedActive)
                ? savedActive.filter(id => validIds.has(id))
                : []
        );
    } catch (e) {
        _ssFilters   = [];
        _ssCache     = {};
        _ssActiveIds = new Set();
    }
    _ssChipState = null;
    renderCustomFilterButtons();
}


/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   QUERY NORMALISATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function _ssNormalise(text) {
    return String(text)
        .toLowerCase()
        .trim()
        .replace(/[^\w\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}


/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   LAYER 3 — PHASE 1: CLIENT-SIDE INSTANT MATCHING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

/**
 * Run the full Phase 1 pipeline: tokenise → resolve to canonical tags.
 * Returns an array of unique canonical tag strings.
 */
function _ssPhase1(query) {
    const tokens = _ssTokenize(query);
    return _ssResolveTokensToTags(tokens);
}

/**
 * Produce unigrams, bigrams, and trigrams from the query.
 * Trigrams/bigrams are checked first so multi-word phrases get priority.
 */
function _ssTokenize(query) {
    const clean = query
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const words = clean.split(' ').filter(w => w.length > 1);

    const trigrams = [];
    for (let i = 0; i < words.length - 2; i++) {
        trigrams.push(words[i] + ' ' + words[i+1] + ' ' + words[i+2]);
    }
    const bigrams = [];
    for (let i = 0; i < words.length - 1; i++) {
        bigrams.push(words[i] + ' ' + words[i+1]);
    }
    // Longest first so multi-word matches win
    return [...trigrams, ...bigrams, ...words];
}

/**
 * Resolve an array of tokens to canonical master tags using:
 *  1. Exact reverse-map lookup (direct tag + all synonyms)
 *  2. Prefix match (token is start of a tag name)
 *  3. Levenshtein ≤ 2 against first word of each tag (typo correction)
 */
function _ssResolveTokensToTags(tokens) {
    const resolved = new Set();

    for (const token of tokens) {
        const tl = token.toLowerCase();

        // 1. Exact reverse-map hit (covers synonyms + direct tags)
        if (_SS_REVERSE_MAP[tl]) {
            resolved.add(_SS_REVERSE_MAP[tl]);
            continue;
        }

        // 2. Prefix match — token must be ≥ 4 chars to avoid false hits
        if (tl.length >= 4) {
            for (const tag of _SS_MASTER_TAGS) {
                if (tag.toLowerCase().startsWith(tl)) {
                    resolved.add(tag);
                    break;
                }
            }
        }

        // 3. Levenshtein fuzzy match against first word of each tag
        if (tl.length >= 4) {
            let best = null, bestDist = 3; // strict cap
            for (const tag of _SS_MASTER_TAGS) {
                const fw = tag.split(' ')[0].toLowerCase();
                if (fw.length < 4) continue;
                const d = _ssLevenshtein(tl, fw);
                if (d < bestDist) { bestDist = d; best = tag; }
            }
            if (best) resolved.add(best);
        }
    }

    return Array.from(resolved);
}

/**
 * Classic dynamic-programming Levenshtein distance.
 * Short-circuits early for the common case where a > b in length by >3.
 */
function _ssLevenshtein(a, b) {
    if (Math.abs(a.length - b.length) > 3) return 99;
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) => {
        const row = new Array(n + 1);
        row[0] = i;
        return row;
    });
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = a[i-1] === b[j-1]
                ? dp[i-1][j-1]
                : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
        }
    }
    return dp[m][n];
}


/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   SPOT SCORING ENGINE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

/**
 * Build a per-spot, per-tag field score map.
 * Returns { [rowid]: { [tagName]: maxFieldScore } }
 * This lets chip removal recompute matched IDs in O(chips × active_spots)
 * without re-scanning all spots again.
 *
 * @param {string[]} tagNames  — canonical tag name strings
 * @param {Array}    spots     — travelSpots array
 */
function _ssBuildSpotTagMatches(tagNames, spots) {
    const result = {};
    for (const spot of spots) {
        const spotScores = {};
        for (const tag of tagNames) {
            const tagLower = tag.toLowerCase();
            let maxScore = 0;
            for (const [field, weight] of Object.entries(_SS_FIELD_SCORE)) {
                const val = ((spot[field] || '') + '').toLowerCase();
                if (val && val.includes(tagLower)) {
                    if (weight > maxScore) maxScore = weight;
                }
            }
            if (maxScore > 0) {
                spotScores[tag] = maxScore;
            }
        }
        if (Object.keys(spotScores).length > 0) {
            result[String(spot.rowid)] = spotScores;
        }
    }
    return result;
}

/**
 * Given a chip state object, compute the sorted array of matched rowIds.
 * Only spots that match at least one active tag are included.
 *
 * @param {{ spotTagMatches, activeTags: Set, confidenceWeights: {} }} chipState
 * @returns {string[]} rowIds sorted by score descending
 */
function _ssRecomputeMatchedIds(chipState) {
    const { spotTagMatches, activeTags, confidenceWeights } = chipState;
    const scores = [];
    for (const [rowid, tagScores] of Object.entries(spotTagMatches)) {
        let total = 0;
        for (const tag of activeTags) {
            if (tagScores[tag]) {
                const cw = confidenceWeights[tag] !== undefined
                    ? confidenceWeights[tag]
                    : _SS_P1_CONFIDENCE_WEIGHT.medium;
                total += tagScores[tag] * cw;
            }
        }
        if (total > 0) scores.push({ rowid, total });
    }
    scores.sort((a, b) => b.total - a.total);
    return scores.map(s => s.rowid);
}


/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   LAYER 3.5 — SPELL CORRECTION  (LanguageTool free public API)
   Runs before Phase 1 so both fuzzy matching and Gemini receive
   clean input.  Falls through silently on any failure.
   Limits: 20 req/min · 2 048 chars — well within search-query usage.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

// Categories / issue types we correct.  Grammar rules are skipped
// intentionally — search queries are inherently un-grammatical and
// a grammar "fix" could alter the user's intent.
const _SS_LT_APPLY_CATEGORIES = new Set([
    'TYPOS', 'SPELLING', 'MISSPELLING',
]);
const _SS_LT_APPLY_ISSUE_TYPES = new Set([
    'misspelling', 'typographical',
]);

/**
 * Spell-correct a short query string using the LanguageTool public API.
 * Returns the corrected string, or null if no correction was needed /
 * the API was unreachable.
 *
 * @param  {string} text  — raw query (≤ 2 048 chars)
 * @returns {Promise<string|null>}
 */
async function _ssSpellCorrect(text) {
    if (!text || text.length > 2048) return null;
    try {
        const body = new URLSearchParams();
        body.append('text', text);
        body.append('language', 'en-US');
        // disabledRules keeps LT from "correcting" Proper Nouns and
        // place names that are legitimate search terms (e.g. "Marais").
        body.append('disabledRules', 'UPPERCASE_SENTENCE_START,EN_UNPAIRED_BRACKETS');

        const resp = await fetch('https://api.languagetool.org/v2/check', {
            method : 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body   : body.toString(),
        });
        if (!resp.ok) return null;

        const data = await resp.json();
        if (!Array.isArray(data.matches) || data.matches.length === 0) return null;

        // Keep only spelling / typo matches that have at least one suggestion
        const applicable = data.matches.filter(m =>
            m.replacements && m.replacements.length > 0 &&
            (
                _SS_LT_APPLY_ISSUE_TYPES.has((m.rule.issueType || '').toLowerCase()) ||
                _SS_LT_APPLY_CATEGORIES.has(((m.rule.category && m.rule.category.id) || '').toUpperCase())
            )
        );
        if (applicable.length === 0) return null;

        // Apply corrections right-to-left so earlier offsets stay valid
        applicable.sort((a, b) => b.offset - a.offset);
        let corrected = text;
        for (const m of applicable) {
            const replacement = m.replacements[0].value;
            corrected = corrected.slice(0, m.offset) + replacement + corrected.slice(m.offset + m.length);
        }

        return corrected !== text ? corrected : null;

    } catch (e) {
        // Network error, rate-limit, parse failure — degrade silently
        console.warn('[SmartSearch] LanguageTool unavailable:', e.message);
        return null;
    }
}


/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   LAYER 4 — PHASE 2: CONSTRAINED AI (GAS → Gemini)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

/**
 * Send rawQuery to GAS → Gemini (constrained to known tags).
 * Returns { filterName, tags: [{tag, confidence}] }.
 * Throws on any failure so the caller can fall back gracefully.
 */
async function _ssPhase2AI(rawQuery, filterId, normKey) {
    try {
        const resp = await fetch(API_URL, {
            method : 'POST',
            mode   : 'cors',
            // No Content-Type header — avoids CORS preflight that GAS fails silently.
            // GAS reads body via e.postData.contents regardless of content-type.
            body   : JSON.stringify({ action: 'smart_search_process', input: rawQuery }),
        });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);

        const rawText = await resp.text();
        console.log('[SmartSearch P2] GAS raw (first 200):', rawText.slice(0, 200));

        let data;
        try { data = JSON.parse(rawText); }
        catch (e) { throw new Error('Non-JSON GAS response: ' + rawText.slice(0, 80)); }

        if (data.result !== 'success') throw new Error(data.error || 'GAS returned error');
        if (!Array.isArray(data.tags) || !data.filterName) {
            throw new Error('Malformed GAS response: ' + JSON.stringify(data).slice(0, 80));
        }

        const p2Tags = data.tags; // [{tag, confidence}]

        // Guard: filter may have been deleted while AI was thinking
        const filterIdx = _ssFilters.findIndex(f => f.id === filterId);
        if (filterIdx < 0) return;

        // Rebuild spot match map with P2 tags
        const p2TagNames    = p2Tags.map(t => t.tag);
        const spotTagMatches = _ssBuildSpotTagMatches(p2TagNames, travelSpots);

        const p2ConfWeights = {};
        p2Tags.forEach(t => {
            p2ConfWeights[t.tag] = _SS_CONFIDENCE_WEIGHT[t.confidence] || 1;
        });

        const p2MatchedRowIds = _ssRecomputeMatchedIds({
            spotTagMatches,
            activeTags: new Set(p2TagNames),
            confidenceWeights: p2ConfWeights,
        });

        // Update filter object
        _ssFilters[filterIdx] = Object.assign({}, _ssFilters[filterIdx], {
            name         : data.filterName,
            tags         : p2Tags,
            matchedRowIds: p2MatchedRowIds,
            source       : 'ai',
            updatedAt    : Date.now(),
        });

        // Update chip state only if user hasn't started removing chips
        if (_ssChipState && _ssChipState.filterId === filterId && _ssChipState.phase !== 'user') {
            _ssChipState = {
                filterId,
                allTags          : p2Tags,
                activeTags       : new Set(p2TagNames),
                spotTagMatches,
                confidenceWeights: p2ConfWeights,
                refinedRowIds    : p2MatchedRowIds,
                phase            : 'p2',
            };
            _ssUpgradeChips(p2Tags);
        }

        // Cache the P2 result
        _ssCache[normKey] = {
            _v        : _SS_CACHE_VERSION,
            filterName: data.filterName,
            tags      : p2Tags,
            savedAt   : Date.now(),
        };
        try { localStorage.setItem(_SS_CACHE_KEY(), JSON.stringify(_ssCache)); } catch (e) { /* quota */ }

        _ssPersist();
        _ssSetAiBadge('refined');
        renderCustomFilterButtons();
        if (typeof renderList                    === 'function') renderList();
        if (typeof updateHeaderBadgeHUDCounters  === 'function') updateHeaderBadgeHUDCounters();
        if (typeof plotDynamicMarkersOnCanvasMap === 'function') plotDynamicMarkersOnCanvasMap();

    } catch (err) {
        console.error('[SmartSearch P2] AI failed:', err.message);
        _ssSetAiBadge('local');
    }
}


/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   MAIN SUBMIT — two-phase orchestrator
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

async function submitSmartSearch() {
    const input = document.getElementById('aiAssistFilterInput');
    if (!input) return;
    const rawQuery = input.value.trim();
    if (!rawQuery || _ssBusy) return;

    _ssBusy = true;
    _ssSendBtnState('loading');

    try {
        // ── Layer 3.5: Spell-correct before anything else ────────────────
        // LanguageTool runs first so both the local fuzzy engine (P1) and
        // Gemini (P2) receive clean input.  Falls through if API is down.
        const corrected = await _ssSpellCorrect(rawQuery);
        const finalQuery = corrected || rawQuery;
        // If the query was corrected, surface it subtly in the badge line
        // so the user knows what was searched (badge transitions to
        // "AI is refining…" once Phase 1 renders, so this is momentary).
        if (corrected) {
            _ssSetAiBadge('corrected', corrected);
            console.log('[SmartSearch] Spell-corrected:', rawQuery, '→', corrected);
        }

        const normKey = _ssNormalise(finalQuery);

        // ── Check v2 cache ───────────────────────────────────────────────
        const cached = _ssCache[normKey];
        if (cached && cached._v === _SS_CACHE_VERSION && Array.isArray(cached.tags)) {
            // Cache hit: skip P1+P2, go straight to full AI result
            const cachedTags    = cached.tags;
            const cachedTagNames = cachedTags.map(t => t.tag);
            const spotTagMatches = _ssBuildSpotTagMatches(cachedTagNames, travelSpots);
            const confWeights    = {};
            cachedTags.forEach(t => { confWeights[t.tag] = _SS_CONFIDENCE_WEIGHT[t.confidence] || 1; });
            const matchedRowIds = _ssRecomputeMatchedIds({
                spotTagMatches,
                activeTags       : new Set(cachedTagNames),
                confidenceWeights: confWeights,
            });

            const existIdx = _ssFilters.findIndex(f => _ssNormalise(f.query || '') === normKey);
            const filterId = existIdx >= 0 ? _ssFilters[existIdx].id : ('cf_' + Date.now());
            const filterObj = {
                id           : filterId,
                name         : cached.filterName,
                tags         : cachedTags,
                matchedRowIds,
                query        : finalQuery,
                source       : 'ai',
                createdAt    : existIdx >= 0 ? _ssFilters[existIdx].createdAt : Date.now(),
                updatedAt    : Date.now(),
            };
            if (existIdx >= 0) { _ssFilters[existIdx] = filterObj; }
            else { _ssFilters.push(filterObj); }

            _ssActiveIds.add(filterId);
            _ssChipState = {
                filterId,
                allTags          : cachedTags,
                activeTags       : new Set(cachedTagNames),
                spotTagMatches,
                confidenceWeights: confWeights,
                refinedRowIds    : matchedRowIds,
                phase            : 'p2',
            };
            _ssPersist();
            input.value = '';
            _ssRenderChips(cachedTags, 'p2');
            _ssSetAiBadge('refined');
            renderCustomFilterButtons();
            if (typeof renderList                    === 'function') renderList();
            if (typeof updateHeaderBadgeHUDCounters  === 'function') updateHeaderBadgeHUDCounters();
            if (typeof plotDynamicMarkersOnCanvasMap === 'function') plotDynamicMarkersOnCanvasMap();
            return;
        }

        // ── Phase 1: instant client-side matching ────────────────────────
        const p1TagNames    = _ssPhase1(finalQuery);
        const spotTagMatches = _ssBuildSpotTagMatches(p1TagNames, travelSpots);
        const p1ConfWeights  = {};
        p1TagNames.forEach(t => { p1ConfWeights[t] = _SS_P1_CONFIDENCE_WEIGHT.medium; });

        const p1Tags        = p1TagNames.map(t => ({ tag: t, confidence: 'medium' }));
        const p1MatchedIds  = _ssRecomputeMatchedIds({
            spotTagMatches,
            activeTags       : new Set(p1TagNames),
            confidenceWeights: p1ConfWeights,
        });

        // Create/upsert filter object
        const existIdx = _ssFilters.findIndex(f => _ssNormalise(f.query || '') === normKey);
        const filterId = existIdx >= 0 ? _ssFilters[existIdx].id : ('cf_' + Date.now());
        // Derive a friendly name from the (corrected) query for Phase 1
        const p1Name = finalQuery.trim().split(/\s+/)
            .filter(w => w.length > 1)
            .slice(0, 3)
            .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
            .join(' ') || finalQuery.slice(0, 25);

        const filterObj = {
            id           : filterId,
            name         : p1Name,
            tags         : p1Tags,
            matchedRowIds: p1MatchedIds,
            query        : finalQuery,
            source       : 'p1',
            createdAt    : existIdx >= 0 ? _ssFilters[existIdx].createdAt : Date.now(),
            updatedAt    : Date.now(),
        };
        if (existIdx >= 0) { _ssFilters[existIdx] = filterObj; }
        else { _ssFilters.push(filterObj); }

        // Set chip state
        _ssChipState = {
            filterId,
            allTags          : p1Tags,
            activeTags       : new Set(p1TagNames),
            spotTagMatches,
            confidenceWeights: p1ConfWeights,
            refinedRowIds    : p1MatchedIds,
            phase            : 'p1',
        };

        _ssActiveIds.add(filterId);
        _ssPersist();
        input.value = '';

        // Render P1 UI immediately
        _ssRenderChips(p1Tags, 'p1');
        _ssSetAiBadge('refining');
        renderCustomFilterButtons();
        if (typeof renderList                    === 'function') renderList();
        if (typeof updateHeaderBadgeHUDCounters  === 'function') updateHeaderBadgeHUDCounters();
        if (typeof plotDynamicMarkersOnCanvasMap === 'function') plotDynamicMarkersOnCanvasMap();

        // Phase 2 fires after finally releases the busy lock.
        // finalQuery (spell-corrected) is used — Gemini gets clean input.
        const _p2filterId = filterId;
        const _p2normKey  = normKey;
        setTimeout(() => _ssPhase2AI(finalQuery, _p2filterId, _p2normKey), 0);

    } finally {
        _ssBusy = false;
        _ssSendBtnState('idle');
    }
}


/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   LAYER 5 — CHIP UI
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

/**
 * Render tag chips into #ssChipStrip and reveal #ssResultArea.
 * Phase 'p1' → all chips neutral; phase 'p2' → confidence-colored.
 *
 * @param {{ tag: string, confidence: string }[]} tags
 * @param {'p1'|'p2'|'user'} phase
 */
function _ssRenderChips(tags, phase) {
    const strip = document.getElementById('ssChipStrip');
    const area  = document.getElementById('ssResultArea');
    if (!strip || !area) return;

    strip.innerHTML = '';
    for (const t of tags) {
        const tagName    = typeof t === 'string' ? t : t.tag;
        const confidence = typeof t === 'string' ? 'medium' : (t.confidence || 'medium');
        const modClass   = phase === 'p1' ? 'ss-chip--neutral' : ('ss-chip--' + confidence);

        const chip = document.createElement('button');
        chip.className  = 'ss-chip ' + modClass;
        chip.dataset.tag = tagName;
        chip.setAttribute('aria-label', 'Remove ' + tagName + ' filter');
        chip.innerHTML  =
            _ssEscapeHtml(tagName) +
            '<span class="ss-chip-x"><i class="fa-solid fa-xmark"></i></span>';
        chip.addEventListener('click', () => _ssRemoveChip(tagName));
        strip.appendChild(chip);
    }

    area.classList.remove('hidden');
    _ssUpdateResetLink();
}

/**
 * Upgrade existing neutral chips to confidence-colored chips (P2 → P2 upgrade).
 * Smooth CSS transition handles the visual change.
 */
function _ssUpgradeChips(p2Tags) {
    const strip = document.getElementById('ssChipStrip');
    if (!strip) return;

    strip.innerHTML = '';
    for (const t of p2Tags) {
        const chip = document.createElement('button');
        chip.className  = 'ss-chip ss-chip--' + (t.confidence || 'medium');
        chip.dataset.tag = t.tag;
        chip.setAttribute('aria-label', 'Remove ' + t.tag + ' filter');
        chip.innerHTML  =
            _ssEscapeHtml(t.tag) +
            '<span class="ss-chip-x"><i class="fa-solid fa-xmark"></i></span>';
        chip.addEventListener('click', () => _ssRemoveChip(t.tag));
        strip.appendChild(chip);
    }
    _ssUpdateResetLink();
}

/**
 * Remove one tag chip from the active set.
 * Recomputes matched IDs and refreshes the list immediately.
 */
function _ssRemoveChip(tagName) {
    if (!_ssChipState) return;

    // ── Instant visual feedback: remove chip from DOM before any computation
    // so the browser can repaint on the very next frame regardless of how
    // long the list re-render takes.
    const strip = document.getElementById('ssChipStrip');
    if (strip) {
        const chipEl = strip.querySelector('[data-tag="' + CSS.escape(tagName) + '"]');
        if (chipEl) chipEl.remove();
    }

    _ssChipState.activeTags.delete(tagName);
    _ssChipState.phase = 'user';

    // ── If no active tags remain, close the filter entirely.
    // Do NOT call _ssResetChips() — the user explicitly removed every chip
    // and should end up with a clean slate, not the full tag set restored.
    if (_ssChipState.activeTags.size === 0) {
        const filterId = _ssChipState.filterId;
        _ssChipState = null;
        _ssActiveIds.delete(filterId);
        _ssPersist();
        const area = document.getElementById('ssResultArea');
        if (area) area.classList.add('hidden');
        renderCustomFilterButtons();
        if (typeof renderList                    === 'function') renderList();
        if (typeof updateHeaderBadgeHUDCounters  === 'function') updateHeaderBadgeHUDCounters();
        if (typeof plotDynamicMarkersOnCanvasMap === 'function') plotDynamicMarkersOnCanvasMap();
        return;
    }

    _ssChipState.refinedRowIds = _ssRecomputeMatchedIds(_ssChipState);

    // Update the persisted filter count
    const filterIdx = _ssFilters.findIndex(f => f.id === _ssChipState.filterId);
    if (filterIdx >= 0) {
        _ssFilters[filterIdx].matchedRowIds = _ssChipState.refinedRowIds;
        _ssPersist();
    }

    _ssUpdateResetLink();
    renderCustomFilterButtons();
    if (typeof renderList                    === 'function') renderList();
    if (typeof updateHeaderBadgeHUDCounters  === 'function') updateHeaderBadgeHUDCounters();
    if (typeof plotDynamicMarkersOnCanvasMap === 'function') plotDynamicMarkersOnCanvasMap();
}

/**
 * Restore all chips to their full set (undo all removals).
 */
function _ssResetChips() {
    if (!_ssChipState) return;
    const allTagNames = _ssChipState.allTags.map(t => (typeof t === 'string' ? t : t.tag));
    _ssChipState.activeTags = new Set(allTagNames);
    // Keep current phase (p2 remains p2, p1 remains p1 — not 'user' anymore)
    if (_ssChipState.phase === 'user') {
        _ssChipState.phase = _ssChipState.allTags.some(t => t.confidence !== 'medium') ? 'p2' : 'p1';
    }

    _ssChipState.refinedRowIds = _ssRecomputeMatchedIds(_ssChipState);

    const filterIdx = _ssFilters.findIndex(f => f.id === _ssChipState.filterId);
    if (filterIdx >= 0) {
        _ssFilters[filterIdx].matchedRowIds = _ssChipState.refinedRowIds;
        _ssPersist();
    }

    _ssRenderChips(_ssChipState.allTags, _ssChipState.phase);
    renderCustomFilterButtons();
    if (typeof renderList                    === 'function') renderList();
    if (typeof updateHeaderBadgeHUDCounters  === 'function') updateHeaderBadgeHUDCounters();
    if (typeof plotDynamicMarkersOnCanvasMap === 'function') plotDynamicMarkersOnCanvasMap();
}

/** Show/hide the Reset link based on whether any chips have been removed. */
function _ssUpdateResetLink() {
    if (!_ssChipState) return;
    const link = document.getElementById('ssResetLink');
    if (!link) return;
    const allActive = _ssChipState.allTags.every(t => {
        const name = typeof t === 'string' ? t : t.tag;
        return _ssChipState.activeTags.has(name);
    });
    if (allActive) { link.classList.add('hidden'); }
    else           { link.classList.remove('hidden'); }
}

/**
 * Update the AI badge line inside #ssResultArea.
 * @param {'corrected'|'refining'|'refined'|'local'|'hidden'} state
 * @param {string} [extra]  — for 'corrected': the corrected query string
 */
function _ssSetAiBadge(state, extra) {
    const dot  = document.getElementById('ssAiBadgeDot');
    const text = document.getElementById('ssAiBadgeText');
    if (!dot || !text) return;

    switch (state) {
        case 'corrected':
            // Transient hint — shows the corrected text briefly before
            // transitioning to 'refining' once Phase 1 chips are rendered.
            dot.className    = 'w-1.5 h-1.5 rounded-full bg-sky-400 shrink-0';
            text.textContent = extra ? '✎ ' + extra : '✎ Corrected';
            text.style.color = 'rgba(56,189,248,0.85)';
            break;
        case 'refining':
            dot.className    = 'w-1.5 h-1.5 rounded-full bg-violet-400 shrink-0 ss-badge-pulse';
            text.textContent = 'AI is refining…';
            text.style.color = 'rgba(167,139,250,0.85)';
            break;
        case 'refined':
            dot.className    = 'w-1.5 h-1.5 rounded-full bg-violet-400 shrink-0';
            text.textContent = '✶ AI refined';
            text.style.color = 'rgba(167,139,250,0.85)';
            break;
        case 'local':
            dot.className    = 'w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0';
            text.textContent = '✶ Smart local filter';
            text.style.color = 'rgba(251,191,36,0.85)';
            break;
        case 'hidden':
        default:
            dot.className    = 'w-1.5 h-1.5 rounded-full bg-slate-500 shrink-0';
            text.textContent = '';
            break;
    }
}


/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   PUBLIC ACCESSOR  (used by getFilteredDatasetRows in aap.js)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

/**
 * Returns a Set of rowId strings for all active custom filters, or null.
 * Checks _ssChipState.refinedRowIds first (chip-refined overrides stored IDs).
 */
function getActiveCustomFilterRowIds() {
    if (_ssActiveIds.size === 0) return null;

    const unionSet = new Set();
    let anyValid = false;

    for (const id of _ssActiveIds) {
        // If chip state belongs to this filter, use its refined rowIds
        if (_ssChipState && _ssChipState.filterId === id && _ssChipState.refinedRowIds) {
            _ssChipState.refinedRowIds.forEach(rid => unionSet.add(String(rid)));
            anyValid = true;
            continue;
        }
        const f = _ssFilters.find(fi => fi.id === id);
        if (f && Array.isArray(f.matchedRowIds)) {
            f.matchedRowIds.forEach(rid => unionSet.add(String(rid)));
            anyValid = true;
        }
    }
    return anyValid ? unionSet : null;
}


/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ACTIVATE / DEACTIVATE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function activateCustomFilter(id) {
    if (_ssActiveIds.has(id)) {
        _ssActiveIds.delete(id);
        // Clear chip state when the filter it belongs to is deactivated
        if (_ssChipState && _ssChipState.filterId === id) {
            _ssChipState = null;
            const area = document.getElementById('ssResultArea');
            if (area) area.classList.add('hidden');
        }
    } else {
        _ssActiveIds.add(id);
    }
    _ssPersist();
    renderCustomFilterButtons();
    if (typeof renderList                    === 'function') renderList();
    if (typeof updateHeaderBadgeHUDCounters  === 'function') updateHeaderBadgeHUDCounters();
    if (typeof plotDynamicMarkersOnCanvasMap === 'function') plotDynamicMarkersOnCanvasMap();
}

function deactivateCustomFilter() {
    if (_ssActiveIds.size === 0) return;
    _ssActiveIds  = new Set();
    _ssChipState  = null;
    _ssPersist();
    renderCustomFilterButtons();
    const area = document.getElementById('ssResultArea');
    if (area) area.classList.add('hidden');
    if (typeof updateFilterCapsuleBadge === 'function') updateFilterCapsuleBadge();
}

function getActiveCustomFilterName() {
    if (_ssActiveIds.size === 0) return null;
    const names = _ssFilters
        .filter(f => _ssActiveIds.has(f.id))
        .map(f => f.name);
    return names.length > 0 ? names : null;
}


/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   CLEAR ALL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function _ssBroomConfirm() {
    if (typeof openSettingsConfirmModal !== 'function') {
        clearAllCustomFilters();
        return;
    }
    openSettingsConfirmModal({
        faIcon        : 'fa-broom',
        iconBg        : 'bg-violet-500/10',
        iconColor     : 'text-violet-400',
        topBar        : 'bg-gradient-to-r from-violet-500 to-indigo-500',
        title         : 'Clear Custom Filters',
        body          : 'All saved AI search filters will be removed. Your search history will be preserved so you can re-run any query instantly.',
        btnLabel      : 'Clear All Filters',
        btnClass      : 'bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500',
        callback      : clearAllCustomFilters,
        cancelCallback: () => {
            if (typeof openUnifiedFilterSheet === 'function') openUnifiedFilterSheet();
        },
    });
}

function clearAllCustomFilters() {
    _ssFilters   = [];
    _ssActiveIds = new Set();
    _ssChipState = null;
    try {
        localStorage.setItem(_SS_FILTERS_KEY(), JSON.stringify([]));
        localStorage.removeItem(_SS_ACTIVE_KEY());
    } catch (e) { /* ignore */ }
    renderCustomFilterButtons();
    const area = document.getElementById('ssResultArea');
    if (area) area.classList.add('hidden');
    if (typeof renderList                    === 'function') renderList();
    if (typeof updateHeaderBadgeHUDCounters  === 'function') updateHeaderBadgeHUDCounters();
    if (typeof plotDynamicMarkersOnCanvasMap === 'function') plotDynamicMarkersOnCanvasMap();
}


/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   RENDER  — Custom Filters pill row
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function renderCustomFilterButtons() {
    const section = document.getElementById('customFiltersSection');
    const grid    = document.getElementById('customFilterButtonsGrid');
    const notice  = document.getElementById('ssFilterNotice');
    if (!section || !grid) return;

    if (_ssFilters.length === 0) {
        section.classList.add('hidden');
        if (notice) notice.classList.add('hidden');
        return;
    }
    section.classList.remove('hidden');
    grid.innerHTML = '';

    _ssFilters.forEach(f => {
        const isActive = _ssActiveIds.has(f.id);
        // If chip state is active for this filter, use refined count
        let count;
        if (_ssChipState && _ssChipState.filterId === f.id && _ssChipState.refinedRowIds) {
            count = _ssChipState.refinedRowIds.length;
        } else {
            count = Array.isArray(f.matchedRowIds) ? f.matchedRowIds.length : 0;
        }

        const sourceIconHTML = f.source === 'ai'
            ? `<i class="fa-solid fa-wand-magic-sparkles text-[8px] shrink-0 ${isActive ? 'text-violet-200' : 'text-violet-400/50'}"></i>`
            : `<i class="fa-solid fa-sparkles text-[8px] shrink-0 ${isActive ? 'text-sky-200' : 'text-sky-400/50'}"></i>`;

        const btn = document.createElement('button');
        btn.className = `custom-filter-btn${isActive ? ' active' : ''}`;
        btn.setAttribute('style', '-webkit-tap-highlight-color:transparent;-webkit-appearance:none;appearance:none;');
        btn.setAttribute('aria-pressed', String(isActive));
        btn.setAttribute('aria-label', `Custom filter: ${f.name} — ${count} spot${count !== 1 ? 's' : ''}`);
        btn.onclick = () => activateCustomFilter(f.id);

        btn.innerHTML =
            sourceIconHTML +
            `<span class="truncate max-w-[88px]">${_ssEscapeHtml(f.name)}</span>` +
            `<span class="custom-filter-count">${count}</span>`;

        grid.appendChild(btn);
    });
}


/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   PERSIST HELPERS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function _ssPersist() {
    try {
        localStorage.setItem(_SS_FILTERS_KEY(), JSON.stringify(_ssFilters));
        if (_ssActiveIds.size > 0) {
            localStorage.setItem(_SS_ACTIVE_KEY(), JSON.stringify([..._ssActiveIds]));
        } else {
            localStorage.removeItem(_SS_ACTIVE_KEY());
        }
    } catch (e) {
        console.warn('[SmartSearch] localStorage write failed:', e);
    }
}


/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   UI STATE HELPERS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function _ssSendBtnState(state) {
    const btn  = document.getElementById('ssSmartSearchSendBtn');
    const icon = document.getElementById('ssSmartSearchSendIcon');
    if (!btn || !icon) return;
    if (state === 'loading') {
        btn.disabled      = true;
        btn.style.opacity = '0.55';
        icon.className    = 'fa-solid fa-spinner fa-spin text-violet-400 text-[11px]';
    } else {
        btn.disabled      = false;
        btn.style.opacity = '';
        icon.className    = 'fa-solid fa-paper-plane text-violet-400 text-[11px]';
    }
}

function _ssShowNotice(html, durationMs) {
    const el = document.getElementById('ssFilterNotice');
    if (!el) return;
    el.innerHTML = html;
    el.classList.remove('hidden');
    clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(() => el.classList.add('hidden'), durationMs || 5000);
}


/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   KEYBOARD SUPPORT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function ssHandleInputKeydown(event) {
    if (event.key === 'Enter') {
        event.preventDefault();
        submitSmartSearch();
    }
}


/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   INTERNAL UTILITIES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function _ssEscapeHtml(str) {
    return String(str)
        .replace(/&/g,  '&amp;')
        .replace(/</g,  '&lt;')
        .replace(/>/g,  '&gt;')
        .replace(/"/g,  '&quot;')
        .replace(/'/g,  '&#39;');
}
