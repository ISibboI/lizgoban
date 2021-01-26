#!/usr/bin/python3

import sys, requests, time, argparse, subprocess, yaml, datetime, os, signal

parser = argparse.ArgumentParser(description = "Automated AI review of OGS games")
mode_argument_group = parser.add_argument_group("Mode of operation")
mode_argument_group = mode_argument_group.add_mutually_exclusive_group(required = True)
mode_argument_group.add_argument("--analyse-game", type = str, metavar = "GAME_ID", help = "Analyse the game with the given id.")
mode_argument_group.add_argument("--schedule", type = str, metavar = "FILE", nargs = "?", const = "timetable.yaml", default = None, action = "store", help = "A yaml (or json) file containing a game schedule. If this option is given, games will automatically be tracked according to the schedule. This defaults to 'timetable.yaml'")
mode_argument_group.add_argument("--egf-tournament", type = str, metavar = "URL", help = "An EGF tournament website. If this option is given, games will automatically be tracked according to the tournaments schedule.")

ai_argument_group = parser.add_argument_group("Analysis")
ai_argument_group.add_argument("--ai-command", type = str, metavar = "COMMAND", default = "npm start -- -c config.json -j '{\"repl\": true}'", help = "The command used to launch the AI.")
ai_argument_group.add_argument("--ai-startup-time", type = int, metavar = "SECONDS", default = 5, help = "Time to wait for the AI process to start its analysis.")
ai_argument_group.add_argument("--auto-terminate-after", type = int, metavar = "MINUTES", default = 10, help = "Terminate the analysis <MINUTES> minutes after the game has ended and all moves were entered.")
ai_argument_group.add_argument("--analysis-move-interval", type = int, metavar = "SECONDS", default = 10, help = "Enter a move into the AI at most every <SECONDS> seconds. This also limits the OGS poll interval.")

scheduling_argument_group = parser.add_argument_group("Scheduling")
scheduling_argument_group.add_argument("--ogs-player-polling-interval", type = int, metavar = "SECONDS", default = 10, help = "When waiting for a game to start, poll the OGS player's page at most every <SECONDS> seconds.")
scheduling_argument_group.add_argument("--maximum-game-early-start", type = int, metavar = "MINUTES", default = 2, help = "Start polling for a game <MINUTES> minutes before it is supposed to start.")
scheduling_argument_group.add_argument("--maximum-game-delay", type = int, metavar = "MINUTES", default = 60, help = "Wait up to <MINUTES> minutes after a games start time before considering it cancelled.")
scheduling_argument_group.add_argument("--maximum-game-runtime", type = int, metavar = "MINUTES", default = 360, help = "Excpet games to not run longer than <MINUTES> minutes. When executing a schedule, games that started more than '--maximum-game-delay' + '--maximum-game-runtime' minutes in the past are ignored.")

args = parser.parse_args()

def translate_move(move):
	# Handle pass first
	if move[0] == -1 and move[1] == -1:
		return "pass"

	x = move[0]
	y = 19 - move[1]

	# Letter I does not exist in Go notation
	if x >= 8:
		x += 1
	x = chr(ord('A') + x)
	return str(x) + str(y)

def ai_command(ai, command):
	if is_ai_running(ai):
		ai.stdin.write(bytes(command + '\n', encoding = "utf-8"))
		ai.stdin.flush()
	else:
		print("Cannot forward AI command since AI is not running.")

def is_ai_running(ai):
	return ai.poll() is None

# Returns True if the game finished properly.
# Returns False if the game contained too little moves.
def track_game(game_id):
	moves = []

	# Start ai
	ai = subprocess.Popen(args.ai_command, stdin = subprocess.PIPE, stdout = subprocess.DEVNULL, shell = True, preexec_fn = os.setsid)
	time.sleep(args.ai_startup_time)
	running = True

	while running:
		while running:
			try:
				if not is_ai_running(ai):
					print("Stop tracking game since AI terminated.")
					running = False
					return

				r = requests.get("https://online-go.com/api/v1/games/" + str(game_id))
				if r.status_code != 200:
					time.sleep(2)
				else:
					break
			except:
				print("Error downloading from OGS.")
				time.sleep(2)

		game_status = r.json()
		new_moves = game_status["gamedata"]["moves"]
		i = 0

		# We search for the first mismatch between moves
		while i < len(new_moves) and i < len(moves):
			if moves[i] != new_moves[i]:
				break
			else:
				i += 1

		# If there was a mismatch within the old moves, then we need to undo
		if i < len(moves):
			ai_command(ai, 'mimic("undo_ntimes", ' + (len(moves) - i) + ')')
			moves = moves[:i]

		# Now, moves is a prefix of new_moves, so we only need to add the remaining moves from new_moves
		slept = 0
		while i < len(new_moves) and running:
			if not is_ai_running(ai):
				print("Stop tracking game since AI terminated.")
				running = False
				return

			ai_command(ai, 'mimic("play", "' + translate_move(new_moves[i]) + '")')
			time.sleep(args.analysis_move_interval)
			moves.append(new_moves[i])
			i += 1
			slept += 1


		# Check if the game is finished, and do not poll more moves if it did
		game_phase = game_status["gamedata"]["phase"]
		if game_phase == "finished":
			print("Game has finished.")
			running = False
			break

		# If the game is not finished, make sure we slept enough to obey the polling intervals
		if slept < 1:
			time.sleep(args.analysis_move_interval)

	# If the AI is running after the game finished, let it run for the auto termination delay
	if is_ai_running(ai):
		print("Running AI for another {} minutes.".format(args.auto_terminate_after))

		end_sleep_time = datetime.datetime.now() + datetime.timedelta(minutes = args.auto_terminate_after)
		while is_ai_running(ai) and datetime.datetime.now() < end_sleep_time:
			sleep_time = min(10, (end_sleep_time - datetime.datetime.now()).total_seconds())
			time.sleep(sleep_time)

		print("Terminating AI")
		os.killpg(os.getpgid(ai.pid), signal.SIGTERM)

		# Check if the ai terminated properly
		try:
			ai.wait(timeout = 10)
		except TimeoutExpired:
			sys.exit("AI did not terminate after ten seconds.")

		if is_ai_running(ai):
			sys.exit("AI did not terminate, even though wait was successful.")
		else:
			print("AI terminated successfully")

	return len(moves) >= 50


class PlayerIdDictionary:
	def __init__(self):
		self.dictionary = {}

	def get_player_id(self, player_name):
		if player_name in self.dictionary:
			return self.dictionary[player_name]

		print("Getting player id for {}.".format(player_name))

		try:
			r = requests.get("https://online-go.com/api/v1/ui/omniSearch?q=" + player_name)
		except Exception:
			print("Error getting player id from OGS.")
			return None
		if r.status_code != 200:
			return None

		players = r.json()["players"]
		for player in players:
			if player["username"] == player_name:
				player_id = player["id"]
				self.dictionary[player_name] = player_id
				return player_id

		sys.exit("Player with name {} does not exist.".format(player_name))

player_id_dictionary = PlayerIdDictionary()

class Game:
	def __init__(self, start_datetime, player1, player2):
		self.start_datetime = start_datetime
		self.player1 = player1
		self.player2 = player2
		self.player1_id = None
		self.player2_id = None
		self.is_finished = False
		self.game_id = None

	def __str__(self):
		return "Game{id}({player1} VS {player2} at {start_datetime}{finished})".format(
			id = "[{}]".format(self.game_id) if self.game_id is not None else "",
			player1 = self.player1,
			player2 = self.player2,
			start_datetime = self.start_datetime.strftime("%Y-%m-%dT%H:%M:%S"),
			finished = " (finished)" if self.is_finished else "",
		)

	def get_missing_player_ids(self):
		if self.player1_id is None:
			self.player1_id = player_id_dictionary.get_player_id(self.player1)
		if self.player2_id is None:
			self.player2_id = player_id_dictionary.get_player_id(self.player2)

		return self.player1_id is not None and self.player2_id is not None


def parse_schedule(schedule):
	game_list = []

	if "days" not in schedule:
		sys.exit("Schedule contains no 'days'.")
	days = schedule["days"]
	if len(days) == 0:
		sys.exit("Schedule has no days.")

	for day, games in days.items():
		if len(games) == 0:
			print("Day {} is defined but has no games.".format(day))
			continue

		try:
			datetime.datetime.strptime(day, "%Y-%m-%d")
		except Exception as e:
			print(e)
			sys.exit("Invalid date format: {}. Dates must be given as YYYY-MM-DD.".format(day))

		for game in games:
			player1 = game["players"][0]
			player2 = game["players"][1]
			time = game["time"]
			try:
				start_datetime = datetime.datetime.strptime(day + "T" + time, "%Y-%m-%dT%H:%M") 
			except Exception as e:
				print(e)
				sys.exit("Invalid time format: {}. Times must be given as HH:MM.".format(time))
			game_list.append(Game(start_datetime, player1, player2))

	# Sort games by start time
	# Python sorts are stable by default
	game_list.sort(key = lambda game: game.start_datetime)
	return game_list


# Check if a game is running and store the game_id in the game object if it is.
# Return True if the game is running.
def game_is_running(game):
	if not game.get_missing_player_ids():
		return False

	try:
		r = requests.get("https://online-go.com/api/v1/players/{player_id}/full".format(player_id = game.player1_id))
	except Exception:
		print("Error getting user games from OGS.")
		return False
	if r.status_code != 200:
		return False

	player1 = r.json()
	active_games = player1["active_games"]

	for active_game in active_games:
		black_id = active_game["black"]["id"]
		white_id = active_game["white"]["id"]

		if not ((black_id == game.player1_id and white_id == game.player2_id) or (black_id == game.player2_id and white_id == game.player1_id)):
			# Wrong players
			continue
		if active_game["json"]["time_control"]["speed"] == "correspondence":
			# Ignore correspondence games
			continue

		# Found the right game!
		game.game_id = active_game["id"]
		print("Game has started: " + str(game))
		return True

	return False

def track_game_list(game_list):
	if len(game_list) == 0:
		sys.exit("Game list is empty.")

	surely_finished_timedelta = datetime.timedelta(minutes = args.maximum_game_delay + args.maximum_game_runtime)
	maximum_delay_timedelta = datetime.timedelta(minutes = args.maximum_game_delay)
	early_start_timedelta = datetime.timedelta(minutes = args.maximum_game_early_start)

	while len(game_list) != 0:
		# Iterate over potentially running games
		for game in game_list:
			print("Considering game: " + str(game))

			# First mark all games that have already finished
			if game.start_datetime + surely_finished_timedelta < datetime.datetime.now():
				game.is_finished = True
				print("Marking game as finished because it started more than {} minutes ago.".format(int(surely_finished_timedelta.total_seconds() // 60)))
				continue


			# If we found a game that has not started yet, all remaining games also have not started because of sortedness
			if game.start_datetime - early_start_timedelta > datetime.datetime.now():
				print("It is too early to look for this game.")
				break

			# We found a game that might already have started and might still be running
			if game_is_running(game):
				if track_game(game.game_id):
					print("Marking game as finished because it was successfully tracked.")
					game.is_finished = True
				else:
					print("Not marking game as finished, as it was not tracked successfully.")
					break
			elif game.start_datetime + maximum_delay_timedelta < datetime.datetime.now():
				print("Marking game as finished because it was either delayed longer than {} minutes or is finished already.".format(int(maximum_delay_timedelta.total_seconds() // 60)))
				game.is_finished = True
			else:
				print("Game has not started yet.")
				time.sleep(args.ogs_player_polling_interval)

		# Remove finished games
		game_list = [game for game in game_list if not game.is_finished]

		# Sleep until polling for the next game
		if len(game_list) > 0:
			next_game = game_list[0]
			next_game_first_poll_time = next_game.start_datetime - early_start_timedelta
			if datetime.datetime.now() < next_game_first_poll_time:
				sleep_time = int((next_game_first_poll_time - datetime.datetime.now()).total_seconds())
				if sleep_time > 0:
					print("Sleeping {} seconds until polling for the next game starts: {}".format(sleep_time, next_game))
					time.sleep(sleep_time)


if args.analyse_game is not None:
	track_game(args.analyse_game)
	print("Game finished, AI terminated, so we can terminate as well.")

elif args.schedule is not None:
	try:
		with open(args.schedule, 'r') as yaml_file:
			schedule = yaml.safe_load(yaml_file)
	except Exception:
		sys.exit("Could not load yaml file.")

	game_list = parse_schedule(schedule)
	print("Loaded game_list:")
	for game in game_list:
		print("  " + str(game))

	track_game_list(game_list)
	print("All games from list are finished, terminating.")

elif args.egf_tournament is not None:
	sys.exit("EGF tournament scheduling is not implemented yet.")

else:
	sys.exit("No ")