export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let targetUrl = url.searchParams.get("url");

    if (!targetUrl) {
      return new Response(
        JSON.stringify({ error: "Lütfen '?url=' parametresi ile bir YouTube linki gönderin." }),
        { status: 400, headers: { "Content-Type": "application/json; charset=utf-8" } }
      );
    }

    try {
      // 1. URL'yi Normalize Et
      targetUrl = normalizeUrl(targetUrl);

      const baseHeaders = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Sec-Ch-Ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"Windows"'
      };

      // 2. Video ID'yi Çıkar
      let videoId = extractVideoId(targetUrl);
      let pageHtml = "";

      if (!videoId || isChannelOrLiveUrl(targetUrl)) {
        const pageRes = await getWithConsentCheck(targetUrl, baseHeaders);
        pageHtml = pageRes.html;
        videoId = extractVideoId(pageRes.finalUrl);

        if (!videoId) videoId = extractVideoIdFromHtml(pageHtml);

        if (!videoId) {
          const matchCanon = pageHtml.match(/<link rel="canonical" href="([^"]+)"/);
          if (matchCanon) videoId = extractVideoId(matchCanon[1]);
        }
      }

      if (!videoId) {
        throw new Error("YouTube Video ID veya aktif canlı yayın bulunamadı.");
      }

      // --- 3. CACHE (KV) KONTROLÜ ---
      const CACHE_TTL = 2 * 60 * 60 * 1000; // 2 Saat (Milisaniye cinsinden)
      let cachedData = null;

      if (env.YOUTUBE_CACHE) {
        try {
          cachedData = await env.YOUTUBE_CACHE.get(videoId, { type: "json" });
        } catch (e) {
          // KV okuma hatası olursa yok say
        }
      }

      // Önbellek geçerliyse doğrudan kullan
      if (cachedData && (Date.now() - cachedData.timestamp < CACHE_TTL)) {
        const apiResult = cachedData.result;
        
        if (apiResult.hls_manifest_url) {
          return Response.redirect(apiResult.hls_manifest_url, 302);
        }

        return new Response(JSON.stringify({ ...apiResult, source: "cache" }, null, 2), {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8" }
        });
      }

      // --- 4. YOUTUBE API'DEN YENİDEN ÇEK ---
      if (!pageHtml) {
        const watchPageRes = await getWithConsentCheck(`https://www.youtube.com/watch?v=${videoId}`, baseHeaders);
        pageHtml = watchPageRes.html;
      }

      const apiKeyMatch = pageHtml.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
      const apiKey = apiKeyMatch ? apiKeyMatch[1] : "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";

      const apiResult = await callInnertubePlayer(videoId, apiKey, baseHeaders);

      // --- 5. YENİ VERİYİ KV'YE KAYDET ---
      if (env.YOUTUBE_CACHE) {
        try {
          await env.YOUTUBE_CACHE.put(
            videoId, 
            JSON.stringify({
              timestamp: Date.now(),
              result: apiResult
            }),
            { expirationTtl: 7200 } // Cloudflare KV 2 saatlik otomatik silinme (Saniye)
          );
        } catch (e) {
          // KV yazma hatası olursa yok say
        }
      }

      if (apiResult.hls_manifest_url) {
        return Response.redirect(apiResult.hls_manifest_url, 302);
      }

      return new Response(JSON.stringify({ ...apiResult, source: "live" }, null, 2), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" }
      });

    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json; charset=utf-8" }
      });
    }
  }
};

// --- YARDIMCI FONKSİYONLAR ---

function normalizeUrl(urlStr) {
  try {
    let parsed = new URL(urlStr);
    if (parsed.hostname === "gaming.youtube.com") {
      parsed.hostname = "www.youtube.com";
    } else if (parsed.hostname === "youtu.be") {
      const videoId = parsed.pathname.substring(1);
      return `https://www.youtube.com/watch?v=${videoId}`;
    }
    if (parsed.protocol !== "https:") {
      parsed.protocol = "https:";
    }
    return parsed.toString();
  } catch (e) {
    return urlStr;
  }
}

function isChannelOrLiveUrl(urlStr) {
  try {
    const path = new URL(urlStr).pathname;
    return path.includes("/live") || path.includes("/channel/") || path.includes("/@");
  } catch (e) {
    return false;
  }
}

function extractVideoId(urlStr) {
  const patterns = [
    /youtube\.com\/(?:v\/|live\/|watch\?(?:.*&)?v=)([\w-]{11})/,
    /youtu\.be\/([\w-]{11})/,
    /youtube\.com\/embed\/([\w-]{11})/
  ];
  for (const pattern of patterns) {
    const match = urlStr.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function extractVideoIdFromHtml(html) {
  const matchId = html.match(/"videoId"\s*:\s*"([\w-]{11})"/);
  if (matchId) return matchId[1];

  const matchProp = html.match(/itemprop="videoId" content="([\w-]{11})"/);
  if (matchProp) return matchProp[1];

  return null;
}

async function getWithConsentCheck(url, headers) {
  let response = await fetch(url, { headers });
  let finalUrl = response.url;
  let html = await response.text();

  if (new URL(finalUrl).hostname === "consent.youtube.com") {
    const formActionMatch = html.match(/<form action="([^"]+)"/);
    if (formActionMatch) {
      const target = formActionMatch[1];
      const inputRegex = /<input type="hidden" name="([^"]+)" value="([^"]*)"/g;
      const formData = new URLSearchParams();
      
      let match;
      while ((match = inputRegex.exec(html)) !== null) {
        formData.append(match[1], match[2]);
      }

      const setCookie = response.headers.get("Set-Cookie");
      const postHeaders = { ...headers, "Content-Type": "application/x-www-form-urlencoded" };
      if (setCookie) postHeaders["Cookie"] = setCookie;

      const postRes = await fetch(target, {
        method: "POST",
        headers: postHeaders,
        body: formData.toString()
      });
      
      finalUrl = postRes.url;
      html = await postRes.text();
    }
  }

  return { html, finalUrl };
}

async function callInnertubePlayer(videoId, apiKey, headers) {
  const apiUrl = `https://www.youtube.com/youtubei/v1/player?key=${apiKey}`;
  const payload = {
    videoId: videoId,
    contentCheckOk: true,
    racyCheckOk: true,
    context: {
      client: {
        clientName: "TVHTML5",
        clientVersion: "7.20240411.10.00",
        platform: "TV",
        clientScreen: "WATCH",
      },
      user: { lockedSafetyMode: false },
      request: { useSsl: true },
    },
  };

  const res = await fetch(apiUrl, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await res.json();

  const playability = data.playabilityStatus || {};
  if (playability.status !== "OK") {
    throw new Error(`Video oynatılamıyor / Erişilemiyor: ${playability.reason || "Bilinmeyen hata"}`);
  }

  const streamingData = data.streamingData || {};
  
  return {
    video_id: videoId,
    hls_manifest_url: streamingData.hlsManifestUrl || null,
    formats: streamingData.formats || [],
    adaptive_formats: streamingData.adaptiveFormats || []
  };
}
