package com.sidm.core

import org.json.JSONObject
import java.net.URI

/**
 * Which video the person means in SIDM's browser. On feed sites (Facebook,
 * Instagram, TikTok, X, YouTube's home page) a page loads many videos ahead of
 * time, so "the newest video the page loaded" or "the page's address" is often
 * a different video. Instead the browser asks the page which <video> is on
 * screen (playing, or the most visible one) and the links around it
 * ([SCRIPT]), and [pick] turns that into the address of that one video.
 */
object OnScreenVideo {

    /** The address to analyze: a video page ([isFile] false) or the video file itself ([isFile] true). */
    data class Target(val url: String, val isFile: Boolean)

    /** Ancestor levels (closest first) checked before the page's own address is trusted. */
    private const val NEAR_LEVELS = 6

    /**
     * Run in the page. Returns {src, levels}: the on-screen video's file address
     * and, for each ancestor going up, the links inside it. Climbing stops once
     * a level holds many links (it is then the whole feed, not one post).
     */
    const val SCRIPT = """(function(){
  function area(v){var r=v.getBoundingClientRect();
    var w=Math.min(r.right,innerWidth)-Math.max(r.left,0), h=Math.min(r.bottom,innerHeight)-Math.max(r.top,0);
    return w>0&&h>0?w*h:0;}
  var best=null, score=0, vs=document.querySelectorAll('video');
  for(var i=0;i<vs.length;i++){var v=vs[i], a=area(v); if(!a) continue;
    var s=a+(!v.paused&&!v.ended?1e9:0)+(v.currentTime>0?1e8:0); if(s>score){score=s;best=v;}}
  if(!best) return {src:'', levels:[]};
  var levels=[], el=best;
  for(var d=0; el && d<20; d++, el=el.parentElement){
    var hrefs=[]; if(el.tagName==='A'&&el.href) hrefs.push(el.href);
    var as=el.querySelectorAll?el.querySelectorAll('a[href]'):[];
    if(as.length>25) break;
    for(var j=0;j<as.length;j++) hrefs.push(as[j].href);
    levels.push(hrefs);
  }
  return {src: best.currentSrc||best.src||'', levels: levels};
})()"""

    private val PATTERNS = listOf(
        Regex("""/watch/?\?(.*&)?v="""), // YouTube, Facebook watch
        Regex("""^/shorts/[^/]+"""),
        Regex("""/reels?/[^/?#]+"""), // Facebook and Instagram reels
        Regex("""/videos?/[^/?#]+"""), // Facebook videos, TikTok, Dailymotion, generic
        Regex("""^/(p|tv)/[^/?#]+"""), // Instagram posts
        Regex("""/status(es)?/\d+"""), // X / Twitter
        Regex("""^/share/[rv]/[^/?#]+"""), // Facebook share links
        Regex("""/comments/[^/?#]+"""), // Reddit
        Regex("""^/pin/\d+"""), // Pinterest
        Regex("""^/(posts|feed/update)/[^?#]+"""), // LinkedIn
        Regex("""^/\d{5,}(/|$)"""), // Vimeo
    )

    private val SHORT_HOSTS = listOf("youtu.be", "fb.watch", "vm.tiktok.com", "vt.tiktok.com")

    /** True for the address of one video (a post, reel, watch page), not a feed or profile. */
    fun isVideoPermalink(url: String?): Boolean {
        if (!Links.isWebLink(url)) return false
        val u = url!!.trim()
        val uri = try {
            URI(u)
        } catch (_: Exception) {
            return false
        }
        val path = uri.rawPath.orEmpty()
        if (Links.hostOf(u) in SHORT_HOSTS) return path.trim('/').isNotEmpty()
        val pathAndQuery = path + (uri.rawQuery?.let { "?$it" } ?: "")
        return PATTERNS.any { it.containsMatchIn(pathAndQuery) }
    }

    /** Reads what [SCRIPT] returned (WebView passes it as JSON) and picks the target. */
    fun fromScript(json: String?, pageUrl: String): Target? {
        val o = try {
            JSONObject(json ?: return null)
        } catch (_: Exception) {
            return null
        }
        val src = o.optString("src")
        val arr = o.optJSONArray("levels")
        val levels = (0 until (arr?.length() ?: 0)).map { i ->
            val l = arr!!.optJSONArray(i)
            (0 until (l?.length() ?: 0)).mapNotNull { l!!.optString(it).ifBlank { null } }
        }
        return pick(pageUrl, levels, src)
    }

    /**
     * The video page for the on-screen video: a video link close around it
     * first (a feed post or a preview on a home page), then the page itself
     * when it is one video's page, then a link further up. With no video page,
     * the video's own file when it is a real address (not a blob: stream).
     * Null when nothing is on screen.
     */
    fun pick(pageUrl: String, levels: List<List<String>>, src: String?): Target? {
        if (levels.isEmpty() && src.isNullOrBlank()) return null
        fun firstIn(range: List<List<String>>) = range.asSequence().flatten().firstOrNull { isVideoPermalink(it) }
        firstIn(levels.take(NEAR_LEVELS))?.let { return Target(clean(it), false) }
        if (isVideoPermalink(pageUrl)) return Target(pageUrl, false)
        firstIn(levels.drop(NEAR_LEVELS))?.let { return Target(clean(it), false) }
        if (src != null && (src.startsWith("http://") || src.startsWith("https://"))) return Target(src, true)
        return null
    }

    /** Drops the #fragment: it never changes which video a page shows. */
    private fun clean(url: String) = url.substringBefore('#')
}
