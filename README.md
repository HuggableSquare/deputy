# 👮 deputy

deputy is a comic book focused opds (+ pse) server, with very specific goals and tradeoffs  
you probably want one of these instead:

* [gotson/komga: Media server for comics/mangas/BDs/magazines/eBooks with API, OPDS and Kobo Sync support](https://github.com/gotson/komga)
* [Kareadita/Kavita: Kavita is a fast, feature rich, cross platform reading server. Built with the goal of being a full solution for all your reading needs. Setup your own server and share your reading collection with your friends and family.](https://github.com/Kareadita/Kavita)
* [ajslater/codex: Codex is a web based comic archive browser and reader](https://github.com/ajslater/codex)
* [stumpapp/stump: A free and open source comics, manga and digital book server with OPDS support (WIP)](https://github.com/stumpapp/stump)

## goals/design decisions

* opds and pse support
* incredibly simple
  * no persistence layer
  * no frontend
  * uses filesystem as organization
* fast (relatively)
* works with [Panels](https://www.panels.app/)
* support for cbz, cbr, and pdf
