// Simple SPA that shows Wikidata items (P625) inside the current map bbox
(function(){
  const WDQS = 'https://query.wikidata.org/sparql';
  const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';

  const map = L.map('map').setView([0,0], 2);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  const markers = L.markerClusterGroup();
  map.addLayer(markers);
  // Map QID -> marker to avoid duplicates and allow merging
  const idToMarker = new Map();

  const zoomThresholdInput = document.getElementById('zoomThreshold');
  const labelZoomInput = document.getElementById('labelZoom');
  const pauseBtn = document.getElementById('pauseBtn');
  const statusEl = document.getElementById('status');
  const detailsEl = document.getElementById('details');

  const sidebarToggle = document.getElementById('sidebarToggle');
  const appEl = document.getElementById('app');
  // restore collapsed state from localStorage
  try{
    const stored = localStorage.getItem('wikicoord.sidebarCollapsed');
    if(stored === 'true') appEl.classList.add('collapsed');
  }catch(e){}
  if(sidebarToggle){
    sidebarToggle.addEventListener('click', ()=>{
      const collapsed = appEl.classList.toggle('collapsed');
      try{ localStorage.setItem('wikicoord.sidebarCollapsed', collapsed ? 'true' : 'false'); }catch(e){}
      // after toggling, update map size so tiles and controls reflow correctly
      try{ setTimeout(()=>map.invalidateSize(), 200); }catch(e){}
      // update button label for accessibility
      sidebarToggle.setAttribute('aria-pressed', String(collapsed));
    });
  }

  let paused = false;
  if(pauseBtn){
    pauseBtn.addEventListener('click', ()=>{
      paused = !paused;
      pauseBtn.textContent = paused ? 'Resume downloads' : 'Pause downloads';
      setStatus(paused ? 'paused' : 'ready');
      if(!paused){
        // immediately trigger an update when resuming
        lastFetchToken = Date.now();
        fetchItemsForVisibleBBox(lastFetchToken);
      }
    });
  }

  let lastFetchToken = 0;
  let debounceTimer = null;

  function setStatus(s){ statusEl.textContent = 'Status: '+s }

  // Compute radius (meters) to search based on zoom. Base ~5000m at zoom 12.
  function computeRadiusMeters(zoom){
    const base = 5000; // meters at zoom 12
    const meters = base * Math.pow(2, 12 - zoom);
    // clamp to reasonable extents
    return Math.max(50, Math.min(meters, 200000));
  }

  function computeBBoxFromCenter(lat, lon, radiusMeters){
    // approximate conversions
    const metersPerDegLat = 111320; // ~111.32 km per degree
    const deltaLat = radiusMeters / metersPerDegLat;
    const metersPerDegLon = metersPerDegLat * Math.cos(lat * Math.PI / 180);
    const deltaLon = Math.abs(metersPerDegLon) > 0.000001 ? radiusMeters / metersPerDegLon : 0.01;
    return {
      minLat: lat - deltaLat,
      maxLat: lat + deltaLat,
      minLon: lon - deltaLon,
      maxLon: lon + deltaLon
    };
  }

  function buildSparql(minLon,minLat,maxLon,maxLat, limit=1000){
    // Use WKT Point literals for the corner parameters to satisfy WDQS
    return `PREFIX geo: <http://www.opengis.net/ont/geosparql#>
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
#defaultView:Map
SELECT ?item ?itemLabel ?coord WHERE {
  ?item wdt:P625 ?coord.
  SERVICE wikibase:box {
    ?item wdt:P625 ?location .
    bd:serviceParam wikibase:cornerWest "Point(${minLon} ${minLat})"^^geo:wktLiteral ;
                    wikibase:cornerEast "Point(${maxLon} ${maxLat})"^^geo:wktLiteral .
  }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} LIMIT ${limit}`;
  }

  async function fetchItemsForVisibleBBox(token){
    if(paused){
      setStatus('paused (not fetching)');
      return;
    }
    const z = map.getZoom();
    const threshold = parseInt(zoomThresholdInput.value,10) || 12;
    if(z < threshold){
      // do not remove already-downloaded items; just skip fetching when zoom is below threshold
      setStatus('zoom below threshold (current '+z+')');
      return;
    }

    // derive bbox from center + zoom-based radius instead of relying on map bounds (avoids layout/sidebar issues)
    const center = map.getCenter();
    const radius = computeRadiusMeters(z);
    const box = computeBBoxFromCenter(center.lat, center.lng, radius);
    const minLat = box.minLat;
    const minLon = box.minLon;
    const maxLat = box.maxLat;
    const maxLon = box.maxLon;
    setStatus('fetching... center '+center.lat.toFixed(5)+','+center.lng.toFixed(5)+' radius '+Math.round(radius)+'m');
    const q = buildSparql(minLon,minLat,maxLon,maxLat,1000);
    const url = WDQS+'?query='+encodeURIComponent(q);

    try{
      const res = await fetch(url, { headers: { 'Accept': 'application/sparql-results+json' } });
      if(token !== lastFetchToken) return; // out of date
      if(!res.ok){ setStatus('SPARQL error: '+res.status); return }
      const data = await res.json();
      if(token !== lastFetchToken) return;
      renderResults(data);
      setStatus('loaded '+data.results.bindings.length+' items (zoom '+z+')');
    }catch(err){
      console.error(err);
      setStatus('fetch failed');
    }
  }

  function renderResults(sparqlJson){
    const bs = sparqlJson.results.bindings;
    for(const b of bs){
      const itemUrl = b.item.value; // e.g. http://www.wikidata.org/entity/Qxxx
      const qid = itemUrl.split('/').pop();
      const label = b.itemLabel ? b.itemLabel.value : itemUrl;
      const coord = b.coord.value; // e.g. "Point(lon lat)"
      const m = coord.match(/Point\s*\(([-0-9.eE]+)\s+([-0-9.eE]+)\)/);
      if(!m) continue;
      const lon = parseFloat(m[1]);
      const lat = parseFloat(m[2]);
      if(idToMarker.has(qid)){
        // merge: update label and coordinates if changed
        const existing = idToMarker.get(qid);
        existing.wdLabel = label;
        // update position if different
        try{
          const pos = existing.getLatLng();
          if(Math.abs(pos.lat - lat) > 1e-6 || Math.abs(pos.lng - lon) > 1e-6){
            existing.setLatLng([lat, lon]);
          }
        }catch(e){/* ignore */}
      } else {
        const marker = createMarker(lat, lon, label, itemUrl);
        markers.addLayer(marker);
        idToMarker.set(qid, marker);
      }
    }
    // ensure icons reflect label visibility for any newly added markers
    try{ updateMarkerIcons(); }catch(e){}
  }

  // Create a marker that may show a label depending on current zoom and label threshold
  function createMarker(lat, lon, label, itemUrl){
    const labelZoom = parseInt(labelZoomInput.value,10) || 16;
    const showLabel = map.getZoom() >= labelZoom;
    let marker;
    if(showLabel){
      const html = `<div class="wd-label-container"><span class="wd-pin"></span><span class="wd-marker-label">${escapeHtml(label)}</span></div>`;
      const icon = L.divIcon({ className: 'wd-div-icon', html: html, iconAnchor: [8, 16] });
      marker = L.marker([lat, lon], { icon });
    } else {
      marker = L.marker([lat, lon]);
    }
    marker.wdLabel = label;
    marker.wdItemUrl = itemUrl;
    // When marker is clicked, show entity details in the sidebar instead of a small popup
    marker.on('click', ()=>{
      try{
        const id = itemUrl.split('/').pop();
        // scroll details to top and show loading
        if(detailsEl){ detailsEl.scrollTop = 0; }
        fetchAndShowEntity(id);
      }catch(e){ console.warn('marker click handler', e); }
    });
    return marker;
  }

  // Update marker icons to show/hide labels based on zoom and labelZoom input
  function updateMarkerIcons(){
    const labelZoom = parseInt(labelZoomInput.value,10) || 16;
    const showLabel = map.getZoom() >= labelZoom;
    const defaultIcon = new L.Icon.Default();
    markers.eachLayer(layer => {
      // only update plain markers (not clusters)
      if(layer instanceof L.Marker){
        try{
          if(showLabel && layer.wdLabel){
            const html = `<div class="wd-label-container"><span class="wd-pin"></span><span class="wd-marker-label">${escapeHtml(layer.wdLabel)}</span></div>`;
            const icon = L.divIcon({ className: 'wd-div-icon', html: html, iconAnchor: [8,16] });
            layer.setIcon(icon);
          } else {
            layer.setIcon(defaultIcon);
          }
        }catch(e){ console.warn('updateMarkerIcons error', e); }
      }
    });
  }


  function escapeHtml(s){ return String(s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c] }) }

  async function fetchAndShowEntity(qid){
    setStatus('loading entity '+qid);
    detailsEl.innerHTML = '<div class="small">Loading '+qid+'…</div>';
    const url = WIKIDATA_API + '?action=wbgetentities&ids='+encodeURIComponent(qid)+'&props=labels|descriptions|claims&languages=en&format=json&origin=*';
    try{
      const res = await fetch(url);
      const data = await res.json();
      const ent = data.entities && data.entities[qid];
      if(!ent){ detailsEl.innerHTML = '<div class="small">No data</div>'; setStatus('ready'); return }

      const label = (ent.labels && ent.labels.en && ent.labels.en.value) || qid;
      const desc = (ent.descriptions && ent.descriptions.en && ent.descriptions.en.value) || '';

      // Collect property IDs and any referenced entity IDs so we can fetch labels in batches
      const claims = ent.claims || {};
      const propIds = new Set();
      const refIds = new Set();
      for(const pid of Object.keys(claims)){
        propIds.add(pid);
        const arr = claims[pid] || [];
        for(const claim of arr){
          const dv = claim.mainsnak && claim.mainsnak.datavalue;
          if(dv && dv.type === 'wikibase-entityid' && dv.value && dv.value.id){
            refIds.add(dv.value.id);
          }
        }
      }

      const labels = {};

      // Helper to fetch labels in chunks (wbgetentities accepts many ids but avoid too long URLs)
      async function fetchLabelsForSet(idSet){
        const all = Array.from(idSet || []);
        const chunkSize = 50;
        for(let i=0;i<all.length;i+=chunkSize){
          const chunk = all.slice(i,i+chunkSize).join('|');
          const labUrl = WIKIDATA_API + '?action=wbgetentities&ids='+encodeURIComponent(chunk)+'&props=labels&languages=en&format=json&origin=*';
          try{
            const lres = await fetch(labUrl);
            const ldata = await lres.json();
            if(ldata && ldata.entities){
              for(const k of Object.keys(ldata.entities)){
                const e = ldata.entities[k];
                if(e && e.labels && e.labels.en && e.labels.en.value) labels[k] = e.labels.en.value;
              }
            }
          }catch(e){
            console.warn('Failed to fetch labels batch', e);
          }
        }
      }

      // Fetch property labels first, then referenced entity labels
      if(propIds.size) await fetchLabelsForSet(propIds);
      if(refIds.size) await fetchLabelsForSet(refIds);

      let html = `<h2><a class="entity-link" href="https://www.wikidata.org/wiki/${qid}" target="_blank">${escapeHtml(label)}</a></h2>`;
      if(desc) html += `<div class="small">${escapeHtml(desc)}</div>`;
      html += '<h3>Statements</h3>';
      if(Object.keys(claims).length === 0) html += '<div class="small">No statements</div>';

      for(const pid of Object.keys(claims)){
        // Prefer a human-readable property label; fall back to the property id if missing
        const propLabel = labels[pid] || pid;
        const arr = claims[pid];
        for(const claim of arr){
          const mainsnak = claim.mainsnak || {};
          const dv = mainsnak.datavalue;
          let valHtml = '';
          if(!dv){ valHtml = '<span class="small">(no value)</span>'; }
          else if(dv.type === 'wikibase-entityid'){
            const vid = dv.value && dv.value.id;
            const vlabel = vid ? (labels[vid] || vid) : null;
            if(vid) valHtml = `<a href="https://www.wikidata.org/wiki/${vid}" target="_blank">${escapeHtml(vlabel)}</a>`;
            else valHtml = escapeHtml(JSON.stringify(dv.value));
          } else if(dv.type === 'string'){
            valHtml = escapeHtml(dv.value);
          } else if(dv.type === 'time'){
            valHtml = escapeHtml(dv.value.time);
          } else if(dv.type === 'quantity'){
            valHtml = escapeHtml(String(dv.value.amount));
          } else if(dv.type === 'globecoordinate' || (dv.value && (dv.value.latitude !== undefined))){
            // globecoordinate value object has latitude and longitude
            const lat = dv.value.latitude;
            const lon = dv.value.longitude;
            valHtml = escapeHtml((lat && lon) ? (lat.toFixed(6)+', '+lon.toFixed(6)) : JSON.stringify(dv.value));
          } else if(dv.type === 'monolingualtext'){
            valHtml = escapeHtml(dv.value.text);
          } else {
            valHtml = escapeHtml(JSON.stringify(dv.value));
          }

          html += `<div class="claim"><div class="prop">${escapeHtml(propLabel)}</div><div class="val">${valHtml}</div></div>`;
        }
      }

      detailsEl.innerHTML = html;
      setStatus('ready');
    }catch(err){
      console.error(err);
      detailsEl.innerHTML = '<div class="small">Failed to load</div>';
      setStatus('ready');
    }
  }

  // Debounced map update
  function scheduleUpdate(){
    if(debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(()=>{
      lastFetchToken = Date.now();
      fetchItemsForVisibleBBox(lastFetchToken);
    }, 500);
  }

  map.on('moveend zoomend', scheduleUpdate);
  zoomThresholdInput.addEventListener('change', scheduleUpdate);
  // update marker icons when zoom changes (labels appear/disappear)
  map.on('zoomend', updateMarkerIcons);
  // update when label threshold changed by user
  const labelZoomInputEl = document.getElementById('labelZoom');
  if(labelZoomInputEl) labelZoomInputEl.addEventListener('change', updateMarkerIcons);

  // initial center: worldwide overview
  map.setView([0, 0], 1);
  scheduleUpdate();

})();
