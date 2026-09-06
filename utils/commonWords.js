'use strict';

// Words that are common enough in ordinary English and ordinary chat that
// seeing them a lot tells you nothing about *this* server.
//
// The dialect profile (utils/corpus.js) works by subtraction: it counts every
// word the server uses, throws this list away, and what is left is the
// server's own vocabulary — names, in-jokes, game terms, memes. That is why
// generic chat filler ("lol", "yeah", "bruh") is included here despite being
// informal: it is universal to Discord, so it is not a fingerprint of this
// particular server.

const COMMON_WORDS = new Set(`
a about above actually after again against all almost also always am an and another any anyone anything are
aren around as at away back bad be because been before being below best better between big both but by
call came can cant come comes coming could couldnt did didnt different do does doesnt doing done dont down
during each either else enough even ever every everyone everything few find first for found from full
get gets getting give given go goes going gone good got gotta great had hadnt half has hasnt have havent
having he her here hers herself him himself his how however i id if ill im in into is isnt it its itself
ive just keep kept know known lack last least left less let lets like liked likes little long look looking
looks lot made make makes making many may maybe me mean means might mine more most much must my myself
near need needs never new next nice no nobody none nor not nothing now of off often oh ok okay old on once
one only onto or other others ought our ours out over own part people per perhaps place please point
probably put quite rather real really right said same saw say saying says see seem seems seen set several
shall she should shouldnt show side since so some somebody someone something sometimes soon sorry
still stuff such sure take taken takes talk tell than that thats the their theirs them themselves then
there theres these they theyre thing things think this those though thought three through time to today
together too took toward true try trying two under until up upon us use used using usually very want
wants was wasnt way we well went were werent what whats when where whether which while who whole whom
whose why will with within without wont work would wouldnt yeah year yes yet you youd your youre yours
yourself yup
lol lmao lmfao rofl haha hahaha hehe xd omg wtf tbh imo imho idk idc ngl fr ffs smh nvm brb afk gg ez
bruh bro dude man guys yo hey hi hello sup nah nope yep yup ya uh um hmm hm ah oh eh ew wow damn
pls plz thx ty thanks tysm np yw sry rip lil bit gonna wanna gotta kinda sorta dunno cuz cus coz
u ur urs r n y k kk ik ily wdym istg iirc afaik btw fyi rn atm asap tbf
the and for you are but not all can get got has have was were with this that they them then than
just like know what when where which while who why how our out over into your youre
message channel server discord bot chat send sent post posted reply replied says said
`.trim().split(/\s+/));

module.exports = { COMMON_WORDS };
