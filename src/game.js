require('./util.js').use(); require('./coord.js').use()
const SGF = require('@sabaki/sgf')

/////////////////////////////////////////////////
// game

// example of history:
// [{move: "D16", is_black: true, move_count: 1, ...},
//  {move: "Q4", is_black: false, move_count: 2, tag: "b", ...},
//  {move: "Q16", is_black: false, move_count: 3, ...},
//  {move: "pass", is_black: true, move_count: 4, ...}]
// 
// Black played pass for the third move and the last move in this example.

// note:
// * move_count = 1 for the first stone, that is history[0].
// * See board_handler() and suggest_handler() for "...".
// * See also do_play() for passes.

let next_game_id = 0
function new_game_id() {return next_game_id++}

function create_game(init_history, init_prop) {
    const self = {}, history = init_history || []  // private
    const prop = init_prop || {  // public
        // move_count is not updated usually.
        // It is only used as record of return-point when sequence is switched.
        move_count: 0, player_black: "", player_white: "",
        sgf_file: "", sgf_str: "", id: new_game_id(),
        trial: false, last_loaded_element: null
    }
    const methods = {
        // mc = move_count (0: empty board, 1: first move, ...)
        len: () => history.length,
        is_empty: () => empty(history),
        ref: mc => history[mc - 1] || {},
        array_until: mc => history.slice(0, mc),
        shorten_to: mc => history.splice(mc),
        last_move: () => (last(history) || {}).move,
        set_last_loaded_element: () => self.last_loaded_element = last(history),
        shallow_copy: () => create_game(history.slice(), merge({}, prop, {
            id: new_game_id(), last_loaded_element: null
        })),
        set_with_reuse: new_history => {
            const com = common_header_length(history, new_history)
            // keep old history for keeping winrate
            history.splice(com, Infinity, ...new_history.slice(com))
        },
        to_sgf: () => game_to_sgf(self),
        import_sgf: sgf_str => import_sgf_to_game(sgf_str, self),
        load_sabaki_gametree: (gametree, index) =>
            load_sabaki_gametree_to_game(gametree, index, self),
        new_tag_maybe: (new_sequence_p, move_count) =>
            new_tag_maybe_for_game(self, new_sequence_p, move_count),
    }
    const array_methods =
          aa2hash(['push', 'pop', 'map', 'forEach', 'slice', 'splice']
                  .map(meth => [meth, (...args) => history[meth](...args)]))
    return merge(self, prop, methods, array_methods)
}

/////////////////////////////////////////////////
// SGF

function game_to_sgf(game) {
    const f = (t, p) => `${t}[${SGF.escapeString(p || '')}]`
    return `(;KM[7.5]${f('PW', game.player_white)}${f('PB', game.player_black)}` +
        game.map(({move: move, is_black: is_black}) =>
                 (is_black ? ';B[' : ';W[') + move2sgfpos(move) + ']').join('') +
        ')'
}

function import_sgf_to_game(sgf_str, game) {
    const clipped = clip_sgf(sgf_str)
    game.load_sabaki_gametree(parse_sgf(clipped)[0])
    game.sgf_str = clipped
}

function parse_sgf(sgf_str) {
    return convert_to_sabaki_sgf_v131_maybe(SGF.parse(sgf_str))
}

// pick "(; ... ... ])...)"
function clip_sgf(sgf_str) {return sgf_str.match(/\(\s*;[^]*\][\s\)]*\)/)[0]}

function convert_to_sabaki_sgf_v131_maybe(parsed) {
    // convert v3.0.0-style to v1.3.1-style for the result of parse() of @sabaki/sgf
    // (ref.) incompatible change in @sabaki/sgf v3.0.0
    // https://github.com/SabakiHQ/sgf/commit/a57dfe36634190ca995755bd83f677375d543b80
    const first = parsed[0]; if (!first) {return null}
    const is_v131 = first.nodes; if (is_v131) {return parsed}
    let nodes = []
    const recur = n => n && (nodes.push(n.data), recur(n.children[0]))
    recur(first)
    const parent = null, minimum_v131_gametree = {nodes, parent}
    return [minimum_v131_gametree]
}

/////////////////////////////////////////////////
// Sabaki gameTree

function load_sabaki_gametree_to_game(gametree, index, game) {
    if (!gametree || !gametree.nodes) {return false}
    const parent_nodes = nodes_from_sabaki_gametree(gametree.parent)
    const new_hist = history_from_sabaki_nodes(parent_nodes.concat(gametree.nodes))
    game.set_with_reuse(new_hist)
    game.set_last_loaded_element()
    const idx = (!index && index !== 0) ? Infinity : index
    const nodes_until_index = parent_nodes.concat(gametree.nodes.slice(0, idx + 1))
    const player_name = bw => (nodes_until_index[0][bw] || [""])[0]
    merge(game, {player_black: player_name("PB"), player_white: player_name("PW"),
                 trial: false})
    const history_until_index = history_from_sabaki_nodes(nodes_until_index)
    const move_count = history_until_index.length
    return move_count
}

function history_from_sabaki_nodes(nodes) {
    const new_history = []; let move_count = 0
    const f = (positions, is_black) => {
        (positions || []).forEach(pos => {
            const move = sgfpos2move(pos)
            move && ++move_count && new_history.push({move, is_black, move_count})
        })
    }
    nodes.forEach(h => {f(h.AB, true); f(h.B, true); f(h.W, false)})
    return new_history
}

function nodes_from_sabaki_gametree(gametree) {
    return (gametree === null) ? [] :
        nodes_from_sabaki_gametree(gametree.parent).concat(gametree.nodes)
}

/////////////////////////////////////////////////
// tag letter

let next_tag_count = 0
function new_tag_maybe_for_game(game, new_sequence_p, move_count) {
    return new_sequence_p ? new_tag_for_game(game) :
           game.ref(move_count) === game.last_loaded_element ?
           last_loaded_element_tag_letter : false
}
function new_tag_for_game(game) {
    const used = game.map(h => h.tag || '').join('')
    const first_unused_index = normal_tag_letters.repeat(2).slice(next_tag_count)
          .split('').findIndex(c => used.indexOf(c) < 0)
    const tag_count = (next_tag_count + Math.max(first_unused_index, 0))
          % normal_tag_letters.length
    next_tag_count = tag_count + 1
    return normal_tag_letters[tag_count]
}

/////////////////////////////////////////////////
// exports

module.exports = {create_game}