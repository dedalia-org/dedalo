<?php declare(strict_types=1);
/**
* CLASS EXEC COMMAND
*
*
*/
class exec_ {



	/**
	* EXEC COMMAND
	* Exec the given command in the php CLI
	* @param string $command
	* @param string $to='2>&1'
	* @return bool
	*/
	public static function exec_command(string $command, string $to='2>&1') : bool {

		$output = null;

		try {

			// escape command for security
			$command = escapeshellcmd( $command ) . ' '. $to;

			// Exec command and get output
			$output = shell_exec( $command );

			// debug
				debug_log(__METHOD__
					. " Notice: exec command: " . PHP_EOL
					. ' command: ' . $command . PHP_EOL
					. ' output: ' . $output
					, logger::WARNING
				);

			if( !$output ) {
				debug_log(__METHOD__
					. " Error processing media command: " . PHP_EOL
					. ' command: ' . $command
					, logger::ERROR
				);
				throw new Exception("Error processing media command", 1);
			}

		}catch(Exception $e){

			debug_log(__METHOD__
				. " Exception: " . PHP_EOL
				. $e->getMessage()
				, logger::ERROR
			);

			return false;
		}


		return true;
	}//end exec_command



	/**
	* EXEC SH FILE
	* @param string $file
	* @return int|null $PID
	*/
	public static function exec_sh_file(string $file) : ?int {

		$PID = null;

		try {
			// exec("sh $file > /dev/null &", $output); # funciona!!! <<<<
			// exec("sh $file > /dev/null 2>&1 & echo $!", $output); # return pid
			// $response = exec("sh $file > /dev/null 2>&1 & echo $!", $output);

			// exec command from sh file
				$response = exec("sh $file > /dev/null & echo $!", $output);

			// response check. Could be empty
				if ( empty($response) ) {
					debug_log(__METHOD__
						. " Warning processing media file. response is empty: " . PHP_EOL
						. ' file: ' . $file
						, logger::WARNING
					);
				}

			// PID. Output returns the PID as ["3647"]
				$PID = isset($output[0])
					? (int)$output[0]
					: null;

			return $PID;

		}catch(Exception $e){

			debug_log(__METHOD__
				. " Exception: " . PHP_EOL
				. ' Exception message: ' . $e->getMessage()
				, logger::ERROR
			);
		}

		return $PID;
	}//end exec_sh_file



	/**
	* EXEC_SH_FILE_ISOLATED
	* @param string $file
	* @return int|null $PID
	*/
	public static function exec_sh_file_isolated(object $options) : ?int {

		// options
			// string process_file. File to manage the data process
			// Sample: DEDALO_CORE_PATH . '/backup/backup_sequence.php'
			$process_file	= $options->process_file;
			// object data. sh data to add as JSON like user_id, etc.
			$data			= $options->data ?? [];
			// wait until process ends
			$wait			= $options->wait ?? false;

		// sh_data
			$sh_data = [
				'server' => [
					'HTTP_HOST'		=> $_SERVER['HTTP_HOST'] ?? 'localhost',
					'REQUEST_URI'	=> $_SERVER['REQUEST_URI'] ?? '',
					'SERVER_NAME'	=> $_SERVER['SERVER_NAME'] ?? 'development'
				]
			];
			foreach ($data as $key => $value) {
				$sh_data[$key] = $value;
			}

		// server_vars
			$server_vars = json_encode($sh_data, JSON_UNESCAPED_SLASHES|JSON_UNESCAPED_UNICODE);

		// output
			$output	= '';

		// wait
			if ($wait!==true) {
				// $output	.= '& ';
				// $output	.= '> /dev/null & echo $!';
				$output	.= '> /dev/null';
			}

		// command
			$command = PHP_BIN_PATH ." $process_file '$server_vars' $output & echo $!";

		// debug
			debug_log(__METHOD__
				." ------> COMMAND EXEC_SH_FILE_ISOLATED ------------------------------------------------:" . PHP_EOL
				.'process_file: ' .$process_file . PHP_EOL
				.'wait: ' . to_string($wait) . PHP_EOL
				.'COMMAND: ' . PHP_EOL
				. $command   . PHP_EOL
				." -------------------------------------------------------------------------------------------"
				, logger::DEBUG
			);

		// exec command
			$exec_response = exec($command, $exec_output);

		// response check. Could be empty
			if ( empty($exec_response) ) {
				debug_log(__METHOD__
					.' Warning processing file. response is empty: ' . PHP_EOL
					.' process_file: ' .$process_file . PHP_EOL
					, logger::WARNING
				);
			}

		// PID. Output returns the PID as ["3647"]
			$PID = isset($exec_output[0])
				? (int)$exec_output[0]
				: null;

		// debug
			debug_log(__METHOD__
				. ' Exec results: ' . PHP_EOL
				. " exec_response: " . to_string($exec_response) . PHP_EOL
				. " exec_output: " . to_string($exec_output) . PHP_EOL
				. " PID: " . to_string($PID)
				, logger::DEBUG
			);


		return $PID;

		/*
		$PID = null;

		try {

			// exec command from sh file
				$response = exec("sh $file > /dev/null & echo $!", $output);

			// response check. Could be empty
				if ( empty($response) ) {
					debug_log(__METHOD__
						. " Warning processing media file. response is empty: " . PHP_EOL
						. ' file: ' . $file
						, logger::WARNING
					);
					// throw new Exception("Error Processing media file", 1);
				}

			// PID. Output returns the PID as ["3647"]
				$PID = isset($output[0])
					? (int)$output[0]
					: null;

			return $PID;

		}catch(Exception $e){

			debug_log(__METHOD__
				. " Exception: " . PHP_EOL
				. ' Exception message: ' . $e->getMessage()
				, logger::ERROR
			);

			// return ('Exception: '. $e->getMessage(). "\n");
		}

		return $PID;
		*/
	}//end exec_sh_file_isolated



	/**
	* GETCOMMANDPATH
	*/
	private static function getCommandPath(string $command='') {
		// note: security vulnerability...
		// should validate that $command doesn't
		// contain anything bad
		$path = "which $command";
		if ($path != null) {
			$path = trim($path); // get rid of trailing line break
			return $path;
		} else {
			return false;
		}
	}//end getCommandPath



	/**
	 * LIVE_EXECUTE_COMMAND
	 * Execute the given command by displaying console output live to the user.
	 *  @param  string  cmd          :  command to be executed
	 *  @return array   exit_status  :  exit status of the executed command
	 *                  output       :  console output of the executed command
	 */
	public static function live_execute_command(string $cmd, bool $live=false) : array {

		if($live) while (@ ob_end_flush()); // end all output buffers if any

	    $proc = popen("$cmd 2>&1 ; echo Exit status : $?", 'r');

		$live_output 	 = "";
	    $complete_output = "";

	    while (!feof($proc))
	    {
	        $live_output     = fread($proc, 4096);
	        $complete_output = $complete_output . $live_output;
	        if ($live) {
	        	echo nl2br( $live_output );
	        	@ flush();
	        }
	    }
	    pclose($proc);

	    // get exit status
	    preg_match('/[0-9]+$/', $complete_output, $matches);

	    // return exit status and intended output
	    return array (
			'exit_status'	=> $matches[0],
			'output'		=> str_replace("Exit status : " . $matches[0], '', nl2br( trim($complete_output) ))
        );
	}//end live_execute_command



	/**
	* REQUEST_CLI
	* Exec given method in CLI using a process runner file
	* @see /core/base/process_runner.php
	* @param object $options
	* {
	* 	class_name: string "request_cli"
	* 	method_name: string "export_records"
	* 	class_file: string
	*	params: object
	* }
	* @return object response { result: mixed, msg: string }
	*/
	public static function request_cli(object $options) : object {

		// options
			$class_name		= $options->class_name;
			$method_name	= $options->method_name;
			$class_file		= $options->class_file;
			$params			= $options->params;

		// PHP_BIN_PATH check. With a wrong path, nohup returns a valid PID but the process dies
		// immediately with an empty output, and nothing is logged. Fail here with a clear message
		// Skipped when open_basedir is set: is_executable returns false for paths outside it
			$open_basedir = ini_get('open_basedir');
			if (!defined('PHP_BIN_PATH') || (empty($open_basedir) && !is_executable(PHP_BIN_PATH))) {
				$response = new stdClass();
					$response->result	= false;
					$response->pid		= 0;
					$response->pfile	= null;
					$response->msg		= 'Error. Unable to launch the background process. PHP binary is not executable. Check PHP_BIN_PATH in config_db.php'
						. ' (current: ' . (defined('PHP_BIN_PATH') ? PHP_BIN_PATH : 'undefined') . ')';
				debug_log(__METHOD__
					. ' ' . $response->msg
					, logger::ERROR
				);
				return $response;
			}

			$safe_params = new stdClass();
			foreach ($params as $key => $value) {
				$safe_params->{$key} = safe_xss($value);
			}

		// server_vars
			// sh_data mandatory vars
			$sh_data = [
				'server' => [
					'HTTP_HOST'		=> $_SERVER['HTTP_HOST'],
					'REQUEST_URI'	=> $_SERVER['REQUEST_URI'],
					'SERVER_NAME'	=> $_SERVER['SERVER_NAME']
				],
				'session_id'		=> session_id(),
				'error_log_path'	=> system::get_error_log_path(), // current PHP-FPM path to use the same error output
				'user_id'			=> logged_user_id(),
				'class_name'		=> $class_name, // class name
				'method_name'		=> $method_name, // method name
				'file'				=> $class_file, // class file to include optional
				'params'			=> $safe_params // object with options passed to the function
			];
			$server_vars = json_encode($sh_data, JSON_UNESCAPED_SLASHES|JSON_UNESCAPED_UNICODE);

		// process file (temporal file where store function output)
			$pfile			= process::get_unique_process_file(); // like 'process_1_2024-03-31_23-47-36_3137757' usually stored in the sessions directory
			$file_path		= process::get_process_path() .'/'. $pfile; // output file with errors and stream data

		// process_runner. File to sh execute that manage given vars calling desired class and method
			$process_runner	= DEDALO_CORE_PATH . '/base/process_runner.php';

		// payload file. The server vars JSON is written to a file instead of being passed
		// as a shell argument. Big requests (like a sqo filter with thousands of section_id)
		// generate a huge argv that hits the kernel limits (MAX_ARG_STRLEN, ARG_MAX) and
		// increases the memory needed by the fork, causing 'exec(): Unable to fork'
		// @see process_runner.php that resolves the '@file' notation
			$payload_path = $file_path . '.json';
			if (file_put_contents($payload_path, $server_vars)===false) {
				debug_log(__METHOD__
					." Error on write process payload file " . PHP_EOL
					.' payload_path: ' . to_string($payload_path)
					, logger::ERROR
				);
				$response = new stdClass();
					$response->result	= false;
					$response->pid		= 0;
					$response->pfile	= $pfile;
					$response->msg		= 'Error. Unable to create the process payload file';
				return $response;
			}
			// the payload contains the session_id. Restrict it to the owner as the
			// sessions directory could be shared with other processes
			@chmod($payload_path, 0600);

		// command composition
			$cmd		= PHP_BIN_PATH . " $process_runner " . escapeshellarg('@'.$payload_path);
			// $command	= "nohup nice -n 19 $cmd >$file_path 2>&1 & echo $!";
			$command	= "nohup nice -n 19 $cmd >$file_path & echo $!";

			// debug
				debug_log(__METHOD__
					." Running tool task in background ($pfile)". PHP_EOL
					." Command: ". PHP_EOL. to_string($command)
					, logger::DEBUG
				);

		// process creation
			$process	= new process($command);
			$pid		= $process->getPid();

		// pid check. When the fork fails (server resources limits, too big command, etc.)
		// exec returns an empty output and the pid is zero. Without this check, a non
		// existing process is registered and the client polls it forever
			if ($pid < 1) {
				if (file_exists($payload_path)) {
					unlink($payload_path);
				}
				debug_log(__METHOD__
					." Error on create the background process. Unable to get a valid PID " . PHP_EOL
					.' command: ' . to_string($command)
					, logger::ERROR
				);
				$response = new stdClass();
					$response->result	= false;
					$response->pid		= 0;
					$response->pfile	= $pfile;
					$response->msg		= 'Error. Unable to create the background process. Check the server resources limits';
				return $response;
			}

		// store process info
			processes::add(
				logged_user_id(),
				$pid,
				$pfile
			);

		// response OK
			$response = new stdClass();
				$response->result	= true;
				$response->pid		= $pid;
				$response->pfile	= $pfile;
				$response->msg		= 'OK. Running publication ' . $pid;


		return $response;
	}//end request_cli



}//end class exec_



/* An easy way to keep in track of external processes.
 * Ever wanted to execute a process in php, but you still wanted to have somewhat control of the process ? Well.. This is a way of doing it.
 * @compatibility: Linux only. (Windows does not work).
 * @author: Peec
 */
class process {

    private $pid;
    private $command;
    private $file;

    public function __construct($cl=false){
        if ($cl != false){
            $this->command = $cl;
            $this->runCom();
        }
    }
    private function runCom(){
    	// reference command for non blocking process
		// $command = 'nohup '.$this->command.' > /dev/null 2>&1 & echo $!';
		$command = $this->command; // untouched command

		// debug
		if(SHOW_DEBUG===true) {
			debug_log(__METHOD__
				. " Executing process command: " . PHP_EOL
				. $command
				, logger::DEBUG
			);
		}

        exec($command, $output);
        // when the fork fails, output is empty and there is no PID to read
        $this->pid = isset($output[0])
            ? (int)$output[0]
            : 0;
    }

    public function setPid($pid){
        $this->pid = $pid;
    }

    public function getPid(){
        return $this->pid;
    }

    public function status(){
        $command = 'ps -p '.$this->pid;
        exec($command, $output);
        if (!isset($output[1]))return false;
        else return true;
    }

    public function start(){
        if ($this->command != '')$this->runCom();
        else return true;
    }

    public function stop(){
        $command = 'kill '.$this->pid;
        exec($command);
        if ($this->status() === false) return true;
        else return false;
    }

    public function setFile($file){
        $this->file = $file;
    }

    public function read(){
        $command = 'tail -n 1 '.$this->file;
        exec($command, $output);
        return $output;
    }

    /**
	* GET_UNIQUE_PROCESS_FILE
	* Calculate unified unique process path name for files
	* @return string $name
	*/
	static function get_unique_process_file() : string {

		$name = 'process_' . logged_user_id() .'_'. date('Y-m-d_H-i-s') .'_'. hrtime(true);

		return $name;
	}//end get_unique_process_file

	/**
	* GET_PROCESS_PATH
	* Calculate common process path name
	* Normally, it is stored in the session directory
	* @return string $dir
	*/
	static function get_process_path() : string {

		$dir = defined('DEDALO_SESSIONS_PATH')
			? DEDALO_SESSIONS_PATH
			: (@session_save_path() ?? '/tmp');

		return $dir;
	}//end get_process_path

}//end class process
