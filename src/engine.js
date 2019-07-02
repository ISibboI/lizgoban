require('./util.js').use(); require('./coord.js').use()

// util
function shallow_copy_array(a) {return a.slice()}
function shallow_copy_hash(b) {return Object.assign({}, b)}
function NOP() {}

function create_leelaz () {

    /////////////////////////////////////////////////
    // setup

    const endstate_delay_millisec = 20
    const speedo_interval_sec = 3, speedo_premature_sec = 0.5
    const speedometer = make_speedometer(speedo_interval_sec, speedo_premature_sec)

    let leelaz_process, arg, is_ready = false
    let command_queue, last_command_id, last_response_id, pondering = true
    let on_response_for_id = {}
    let network_size_text = ''

    // game state
    let move_count = 0, bturn = true

    // util
    const log = (header, s, show_queue_p) => {
        const format = x => (to_s(x).match(/.{0,4}[.].{2}/) || [''])[0]
        const ti = format(Date.now() / 1000 + 0.0001)
        debug_log(`${ti} [${(leelaz_process || {}).pid}] ${header} ${s}` +
                  (show_queue_p ? ` [${command_queue}]` : ''),
                  arg.engine_log_line_length)
    }

    /////////////////////////////////////////////////
    // leelaz action

    // process
    const start = h => {
        const {leelaz_command, leelaz_args, analyze_interval_centisec, wait_for_startup,
               komi, minimum_suggested_moves, engine_log_line_length, ready_handler,
               endstate_handler, suggest_handler, restart_handler, error_handler}
              = arg = h
        log('start leela zero:', JSON.stringify([leelaz_command, ...leelaz_args]))
        is_ready = false; network_size_text = ''
        leelaz_process = require('child_process').spawn(leelaz_command, leelaz_args)
        leelaz_process.stdout.on('data', each_line(stdout_reader))
        leelaz_process.stderr.on('data', each_line(reader))
        set_error_handler(leelaz_process, restart_handler)
        command_queue = []; block_commands_until_ready()
        wait_for_startup || on_ready()
    }
    const restart = h => {kill(); start(h ? {...arg, ...h} : arg)}
    const kill = () => {
        if (!leelaz_process) {return}
        ['stdin', 'stdout', 'stderr']
            .forEach(k => leelaz_process[k].removeAllListeners())
        leelaz_process.removeAllListeners()
        set_error_handler(leelaz_process, e => {})
        leelaz_process.kill('SIGKILL')
    }

    const start_analysis = () => {
        const analyzer = is_katago() ? 'kata-analyze ownership true' : 'lz-analyze'
        const command = is_supported('minmoves') ?
              `${analyzer} interval ${arg.analyze_interval_centisec} minmoves ${arg.minimum_suggested_moves}` :
              `${analyzer} ${arg.analyze_interval_centisec}`
        pondering && leelaz(command)
    }
    const stop_analysis = () => {leelaz('name')}
    const set_pondering = bool => {
        bool !== pondering && ((pondering = bool) ? start_analysis() : stop_analysis())
    }
    const endstate = () => {
        arg.endstate_handler && is_supported('endstate') && leelaz('endstate_map')
    }

    // fixme: unclear
    // up_to_date_response() is turned to be true indirectly
    // by send_to_leelaz as a side effect in check_supported.
    const block_commands_until_ready = () => {
        last_command_id = -1; last_response_id = -2
    }
    let on_ready = () => {
        if (is_ready) {return}; is_ready = true
        send_to_leelaz(`komi ${arg.komi}`)
        // clear_leelaz_board for restart
        const after_all_checks = () => {clear_leelaz_board(); arg.ready_handler()}
        check_supported([['minmoves', 'lz-analyze interval 1 minmoves 30'],
                         ['endstate', 'endstate_map'],
                         ['kata-analyze', 'kata-analyze interval 1']],
                        after_all_checks)
    }
    const on_error = () =>
          (arg.error_handler || arg.restart_handler)()

    // stateless wrapper of leelaz
    let leelaz_previous_history = []
    const set_board = (history) => {
        if (empty(history)) {clear_leelaz_board(); update_move_count([]); return}
        const beg = common_header_length(history, leelaz_previous_history)
        const back = leelaz_previous_history.length - beg
        const rest = history.slice(beg)
        do_ntimes(back, undo1); rest.forEach(play1)
        if (back > 0 || !empty(rest)) {update_move_count(history)}
        leelaz_previous_history = shallow_copy_array(history)
    }
    const play1 = ({move, is_black}) => {leelaz('play ' + (is_black ? 'b ' : 'w ') + move)}
    const undo1 = () => {leelaz('undo')}

    // util
    const leelaz = (s) => {log('queue>', s, true); send_to_queue(s)}
    const update_now = () => {endstate(); start_analysis()}
    const [update_later] = deferred_procs([update_now, endstate_delay_millisec])
    // avoid flicker of endstate
    const update = () => is_supported('endstate') ? update_later() : update_now()
    const clear_leelaz_board = () => {leelaz("clear_board"); leelaz_previous_history = []; update()}
    const start_args = () => arg
    const network_size = () => network_size_text
    const peek_value = (move, cont) => {
        the_nn_eval_reader = value => {the_nn_eval_reader = NOP; cont(value); update()}
        leelaz(join_commands('lz-setoption name visits value 1',
                             `play ${bturn ? 'b' : 'w'} ${move}`,
                             'lz-analyze interval 0',
                             'lz-setoption name visits value 0', 'undo'))
    }

    /////////////////////////////////////////////////
    // command queue

    const send_to_queue = (s) => {
        const remove = f => {command_queue = command_queue.filter(x => !f(x))}
        // useless lz-analyze that will be canceled immediately
        remove(pondering_command_p)
        // duplicated endstate
        endstate_command_p(s) && remove(endstate_command_p)
        // obsolete endstate / peek
        changer_command_p(s) && [endstate_command_p, peek_command_p].map(remove)
        command_queue.push(s); send_from_queue()
    }

    const send_from_queue = () => {
        if (empty(command_queue) || !up_to_date_response()) {return}
        split_commands(command_queue.shift()).map(send_to_leelaz)
    }

    const send_to_leelaz = cmd => {try_send_to_leelaz(cmd)}
    const try_send_to_leelaz = (cmd, on_response) => {
        // see stdout_reader for optional arg "on_response"
        if (do_update_move_count(cmd)) {return}
        const cmd_with_id = `${++last_command_id} ${cmd}`
        on_response && (on_response_for_id[last_command_id] = on_response)
        pondering_command_p(cmd) && speedometer.reset()
        log('leelaz> ', cmd_with_id, true); leelaz_process.stdin.write(cmd_with_id + "\n")
    }

    const update_move_count = history => {
        const move_count = history.length, bturn = !(last(history) || {}).is_black
        const new_state = JSON.stringify({move_count, bturn})
        leelaz(`lizgoban_set ${new_state}`); update()
    }
    const do_update_move_count = cmd => {
        const m = cmd.match(/lizgoban_set (.*$)/); if (!m) {return false}
        const h = JSON.parse(m[1]); move_count = h.move_count; bturn = h.bturn
        send_from_queue(); return true
    }

    const join_commands = (...a) => a.join(';')
    const split_commands = s => s.split(';')
    const up_to_date_response = () => {return last_response_id >= last_command_id}

    const command_matcher = re => (command => command.match(re))
    const pondering_command_p = command_matcher(/^(lz|kata)-analyze/)
    const endstate_command_p = command_matcher(/^endstate_map/)
    const peek_command_p = command_matcher(/play.*undo/)
    const changer_command_p = command_matcher(/play|undo|clear_board/)

    /////////////////////////////////////////////////
    // stdout reader

    // suggest = [suggestion_data, ..., suggestion_data]
    // suggestion_data =
    //   {move: "Q16", visits: 17, winrate: 52.99, order: 4, winrate_order: 3, pv: v} etc.
    // v = ["Q16", "D4", "Q3", ..., "R17"] etc.

    const stdout_reader = (s) => {
        log('stdout|', s)
        const m = s.match(/^([=?])(\d+)/)
        if (m) {
            const ok = (m[1] === '='), id = last_response_id = to_i(m[2])
            const on_response = on_response_for_id[id]
            on_response && (on_response(ok), delete on_response_for_id[id])
        }
        up_to_date_response() && s.match(/^info /) && suggest_reader(s)
        send_from_queue()
    }

    const suggest_reader = (s) => {
        if (!arg.suggest_handler) {return}
        const [i_str, o_str] = s.split(/\s*ownership\s*/)
        const ownership = ownership_parser(o_str)
        const suggest = i_str.split(/info/).slice(1).map(suggest_parser).filter(truep)
              .sort((a, b) => (a.order - b.order))
        const [wsum, visits, scsum] =
              suggest.map(h => [h.winrate, h.visits, h.score_without_komi || 0])
              .reduce(([ws, vs, scs], [w, v, sc]) => [ws + w * v, vs + v, scs + sc * v],
                      [0, 0, 0])
        const winrate = wsum / visits, b_winrate = bturn ? winrate : 100 - winrate
        const visits_per_sec = speedometer.per_sec(visits)
        const score_without_komi = is_katago() && (scsum / visits)
        const add_order = (sort_key, order_key) => {
            suggest.slice().sort((a, b) => (b[sort_key] - a[sort_key]))
                .forEach((h, i) => (h[order_key] = i))
        }
        // winrate is NaN if suggest = []
        add_order('visits', 'visits_order')
        add_order('winrate', 'winrate_order')
        arg.suggest_handler({suggest, visits, b_winrate, visits_per_sec,
                             score_without_komi, ownership})
    }

    // (sample of leelaz output for "lz-analyze 10")
    // info move D16 visits 23 winrate 4668 prior 2171 order 0 pv D16 Q16 D4 Q3 R5 R4 Q5 O3 info move D4 visits 22 winrate 4670 prior 2198 order 1 pv D4 Q4 D16 Q17 R15 R16 Q15 O17 info move Q16 visits 21 winrate 4663 prior 2147 order 2 pv Q16 D16 Q4 D3 C5 C4 D5 F3
    // (sample with "pass")
    // info move pass visits 65 winrate 0 prior 340 order 0 pv pass H4 pass H5 pass G3 pass G1 pass
    // (sample of LCB)
    // info move D4 visits 171 winrate 4445 prior 1890 lcb 4425 order 0 pv D4 Q16 Q4 D16
    // (sample "kata-analyze interval 10 ownership true")
    // info move D17 visits 2 utility 0.0280885 winrate 0.487871 scoreMean -0.773097 scoreStdev 32.7263 prior 0.105269 order 0 pv D17 C4 ... pv D17 R16 ownership -0.0261067 -0.0661169 ... 0.203051
    const suggest_parser = (s) => {
        const to_percent = str => to_f(str) * (is_katago() ? 100 : 1/100)
        const [a, b] = s.split(/pv/); if (!b) {return false}
        const h = array2hash(a.trim().split(/\s+/))
        h.pv = b.trim().split(/\s+/); h.lcb = to_percent(h.lcb || h.winrate)
        h.visits = to_i(h.visits); h.order = to_i(h.order)
        h.winrate = to_percent(h.winrate); h.prior = to_percent(h.prior) / 100
        truep(h.scoreMean) &&
            (h.score_without_komi = h.scoreMean * (bturn ? 1 : -1) + arg.komi)
        h.scoreStdev = to_f(h.scoreStdev || 0)
        return h
    }
    const ownership_parser = s => s && s.trim().split(/\s+/)
          .map(z => to_f(z) * (bturn ? 1 : -1))

    /////////////////////////////////////////////////
    // stderr reader

    let current_reader, the_nn_eval_reader = NOP

    const reader = (s) => {log('stderr|', s); current_reader(s)}

    const main_reader = (s) => {
        let m, c;
        (m = s.match(/Detecting residual layers.*?([0-9]+) channels.*?([0-9]+) blocks/)) &&
            (network_size_text = `${m[1]}x${m[2]}`);
        // "GTP ready" for KataGo
        (m = s.match(/(Setting max tree size)|(GTP ready)/) && on_ready());
        (m = s.match(/Weights file is the wrong version/) && on_error());
        (m = s.match(/NN eval=([0-9.]+)/)) && the_nn_eval_reader(to_f(m[1]));
        s.match(/endstate:/) && (current_reader = endstate_reader)
    }

    current_reader = main_reader

    /////////////////////////////////////////////////
    // reader helper

    const multiline_reader = (parser, finisher) => {
        let buf = []
        return s => {
            const p = parser(s)
            p ? buf.push(p) : (finisher(buf), buf = [], current_reader = main_reader)
        }
    }

    /////////////////////////////////////////////////
    // endstate reader

    const finish_endstate_reader = (endstate) => {
        const f = arg.endstate_handler
        f && f({endstate, endstate_move_count: move_count})
    }

    const parse_endstate_line = (line) => {
        const b_endstate = s => to_i(s) / 1000
        return !line.match(/endstate sum/) && line.trim().split(/\s+/).map(b_endstate)
    }

    const endstate_reader = multiline_reader(parse_endstate_line, finish_endstate_reader)

    /////////////////////////////////////////////////
    // feature checker

    let supported = {}
    const check_supported = (rules, after_all_checks) => {
        if (empty(rules)) {after_all_checks(); return}
        const [feature, cmd] = rules.shift()
        try_send_to_leelaz(cmd, ok => {
            supported[feature] = ok; check_supported(rules, after_all_checks)
        })
    }
    const is_supported = feature => supported[feature]
    const is_katago = () => is_supported('kata-analyze')

    /////////////////////////////////////////////////
    // exported methods

    return {
        start, restart, kill, set_board, update, set_pondering,
        start_args, network_size, peek_value, is_katago,
        // for debug
        send_to_leelaz,
    }

}  // end create_leelaz

/////////////////////////////////////////////////
// exports

module.exports = {create_leelaz}
