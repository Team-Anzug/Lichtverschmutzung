const map = L.map('map', {
  center: [50.726894, 6.337738],
  zoom: 5,
  minZoom: 3,
  maxZoom: 12,
  attributionControl: false,
  maxBounds: [[-85, -180], [85, 180]],
  maxBoundsViscosity: 1.0
});

// Base map:
const streetMap = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  opacity: 0.9
}).addTo(map);

// Light pollution overlay:
const lightPollution = L.tileLayer('https://lightpollutionmap.app/tiles/2024/tile_{z}_{x}_{y}.png', {
  maxNativeZoom: 6,
  maxZoom: 12,
  opacity: 0.5
}).addTo(map);

L.control.layers({ 'Street Map': streetMap }, { 'Light Pollution': lightPollution }).addTo(map);



// BORTLE RADIAL CHART:

let chart = null;
function renderChart(rawValue) {
  document.querySelector("#chart").innerHTML = "";
  const maxValue = 9;
  const value = (rawValue / maxValue) * 100;
  let colorStart, colorEnd;
  if (rawValue <= 4) { colorStart='#09C823'; colorEnd='#ABE5A1'; }
  else if (rawValue <= 6) { colorStart='#FFCC00'; colorEnd='#FFE680'; }
  else { colorStart='#FF0000'; colorEnd='#FF7F7F'; }

  const options = {
    series: [value],
    chart: { height: 350, type: 'radialBar', toolbar: { show: false } },
    plotOptions: {
      radialBar: {
        startAngle: -135,
        endAngle: 225,
        hollow: { size:'70%', background:'#5E86FF', dropShadow:{ enabled:true, top:3, left:0, blur:4, opacity:0.5 } },
        track: { background:'#2B14FF', strokeWidth:'67%', dropShadow:{ enabled:true, top:-3, left:0, blur:4, opacity:0.7 } },
        dataLabels: { show:true, name:{offsetY:-10,color:'white',fontSize:'17px'}, value:{formatter:()=>rawValue, color:'white', fontSize:'45px'} }
      }
    },
    fill: { type:'gradient', gradient:{shade:'dark', type:'horizontal', shadeIntensity:0.5, gradientToColors:[colorEnd], inverseColors:true, opacityFrom:1, opacityTo:1, stops:[0,100]}, colors:[colorStart] },
    stroke:{lineCap:'round'},
    labels:['Bortle']
  };
  chart = new ApexCharts(document.querySelector("#chart"), options);
  chart.render();
}


//  POPULATION DENSITY CHART:

let popChart = null;
async function renderPopChart(country) {
  document.querySelector("#popChart").innerHTML = "";
  try {
    const response = await fetch('http://localhost:8080/API_EN.POP.DNST.csv');
    const data = await response.text();
    const lines = data.split(/\r?\n/).filter(l => l.trim() !== "");
    const parsed = lines.map(line => line.match(/(".*?"|[^",\s]+)(?=\s*,|\s*$)/g).map(s=>s.replace(/^"|"$/g,'')));
    const headers = parsed[0];
    const countryRow = parsed.find(r=>r[0]===country);
    if(!countryRow) return;
    const yearValues = {};
    for(let i=4;i<headers.length;i++){ if(countryRow[i]!=""&&!isNaN(countryRow[i])) yearValues[headers[i]]=parseFloat(countryRow[i]); }
    const allYears = Object.keys(yearValues);
    const last5Years = allYears.slice(-5);
    const seriesData = last5Years.map(y=>yearValues[y]);
    const options = {
      series:[{name:"Population Density", data: seriesData}],
      chart:{type:'area', height:250, toolbar:{show:false}},
      dataLabels:{enabled:false},
      stroke:{curve:'straight'},
      title:{text:'', style:{color:'white'}},
      subtitle:{text:`${country}: People per sq. km of land area`, align:'left', style:{color:'white'}},
      labels:last5Years,
      xaxis:{type:'category', labels:{style:{colors:'white'}}, axisBorder:{show:true,color:'white'}, axisTicks:{show:true,color:'white'}},
      yaxis:{opposite:true, labels:{style:{colors:'white'}}, axisBorder:{show:true,color:'white'}, axisTicks:{show:true,color:'white'}},
      legend:{horizontalAlign:'left', labels:{colors:'white'}}
    };
    popChart = new ApexCharts(document.querySelector("#popChart"), options);
    popChart.render();
  } catch(err){ console.error(err); }
}


//   Map Click Handler:

async function getLocationName(lat,lng){
  try{
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}`);
    const data = await res.json();
    return data.display_name||"Unknown location";
  }catch{return "Lookup failed";}
}

map.on('click', async e=>{
  const {lat,lng}=e.latlng;
  const popup=L.popup().setLatLng(e.latlng).setContent('Fetching light data...').openOn(map);
  try{
    const [lightRes, locName] = await Promise.all([
      fetch(`http://localhost:8080/light?lat=${lat}&lng=${lng}`).then(r=>r.json()),
      getLocationName(lat,lng)
    ]);
    renderChart(lightRes.bortle);
    const country = locName.split(",").slice(-1)[0].trim();
    renderPopChart(country);
    popup.setContent(`<strong>Location:</strong>${locName}<br><strong>Coordinates:</strong>${lat.toFixed(6)},${lng.toFixed(6)}<br><br><strong>Raw Value:</strong>${lightRes.raw_value}<br><strong>SQM:</strong>${lightRes.sqm}<br><strong>Bortle Estimate:</strong>${lightRes.bortle}`);
  }catch(err){ popup.setContent('Error fetching data.'); console.error(err); }
});


//  Search Autocomplete:

const searchInput = document.getElementById('searchInput');
const autocompleteList = document.getElementById('autocompleteList');
let timeout = null;

searchInput.addEventListener('input',()=>{
  const query = searchInput.value.trim();
  if(!query){ autocompleteList.innerHTML=''; return; }
  if(timeout) clearTimeout(timeout);
  timeout=setTimeout(async ()=>{
    try{
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(query)}&limit=5`);
      const results = await res.json();
      autocompleteList.innerHTML='';
      results.forEach(loc=>{
        const item=document.createElement('div');
        item.className='autocomplete-item';
        item.innerText=loc.display_name;
        item.addEventListener('click', async () => {
          const lat = parseFloat(loc.lat), lon = parseFloat(loc.lon);

          autocompleteList.innerHTML = '';

          map.setView([lat, lon], 10);

          // Show popup:
          const popup = L.popup().setLatLng([lat, lon]).setContent('Fetching light data...').openOn(map);

          try {
            const lightRes = await fetch(`http://localhost:8080/light?lat=${lat}&lng=${lon}`).then(r => r.json());
            renderChart(lightRes.bortle);
            const country = loc.display_name.split(",").slice(-1)[0].trim();
            renderPopChart(country);
            popup.setContent(`
              <strong>Location:</strong> ${loc.display_name}<br>
              <strong>Coordinates:</strong> ${lat.toFixed(6)}, ${lon.toFixed(6)}<br><br>
              <strong>Raw Value:</strong> ${lightRes.raw_value}<br>
              <strong>SQM:</strong> ${lightRes.sqm}<br>
              <strong>Bortle Estimate:</strong> ${lightRes.bortle}
            `);

            searchInput.value = '';

          } catch(err) {
            popup.setContent('Error fetching data.');
            console.error(err);
            searchInput.value = ''; 
          }
        });

        autocompleteList.appendChild(item);
      });
    }catch(err){ console.error(err);}
  },300);
});

document.addEventListener('click', e=>{
  if(!searchInput.contains(e.target)) autocompleteList.innerHTML='';
});

// Initial charts:
renderChart(0);
renderPopChart("Germany");